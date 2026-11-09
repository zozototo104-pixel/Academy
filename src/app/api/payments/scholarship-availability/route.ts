import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  scholarshipOrganizationEnabled,
  countOccupiedSeats,
  joinScholarshipWaitlist,
  leaveScholarshipWaitlist,
  WaitlistError,
} from '@/lib/scholarship-waitlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Public campaign facts for one program: whether an organized scholarship
// currently covers it and how many seats remain. A remaining-seat count is
// a live snapshot, never a reservation or a promise.
async function campaignsForProgram(programId: string) {
  const definitions: any[] = await db.scholarshipDefinition.findMany({
    where: { active: true, programs: { some: { programId } } },
    include: { programs: { select: { programId: true, seats: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const now = Date.now()
  const campaigns: any[] = []
  for (const definition of definitions) {
    if (definition.startsAt && new Date(definition.startsAt).getTime() > now) continue
    if (definition.endsAt && new Date(definition.endsAt).getTime() < now) continue
    const program = (definition.programs || []).find((item: any) => item.programId === programId)
    if (!program) continue
    const seats = program.seats ?? null
    const occupied = seats == null ? 0 : await countOccupiedSeats(db, definition.id, programId)
    campaigns.push({
      definitionId: definition.id,
      title: definition.title,
      seats,
      remaining: seats == null ? null : Math.max(0, seats - occupied),
      full: seats != null && occupied >= seats,
    })
  }
  return campaigns
}

// The best live GENERAL offer for a program (owner's display spec,
// 2026-11-09): a general grant carries no seats and no waitlist — it is
// a price offer. The discounted figure is computed here from the
// program's real price (percent stored as basis points, half-up cent
// rounding, the same rule the issuance quote uses). The display never
// changes an invoice: the discount itself lands only when the admin
// issues the grant code and it is approved, exactly like today.
async function generalOfferForProgram(programId: string) {
  const program = await db.program
    .findUnique({ where: { id: programId }, select: { price: true } })
    .catch(() => null)
  const priceCents = Math.max(0, Math.round(Number(program?.price || 0) * 100))
  const definitions: any[] = await db.scholarshipDefinition.findMany({
    where: { active: true, scope: 'GENERAL' },
    orderBy: { createdAt: 'desc' },
  })
  const now = Date.now()
  let best: any = null
  for (const definition of definitions) {
    if (definition.startsAt && new Date(definition.startsAt).getTime() > now) continue
    if (definition.endsAt && new Date(definition.endsAt).getTime() < now) continue
    const coversTuition = definition.coverage === 'TUITION' || definition.coverage === 'BOTH'
    let percentBps: number | null = null
    let discountCents = 0
    if (definition.valueMode === 'FULL') {
      percentBps = 10000
      discountCents = coversTuition ? priceCents : 0
    } else if (definition.valueMode === 'PERCENT') {
      percentBps = definition.value
      discountCents = coversTuition ? Math.round((priceCents * definition.value) / 10000) : 0
    } else if (coversTuition) {
      discountCents = Math.min(definition.value, priceCents)
    }
    const candidate = {
      definitionId: definition.id,
      title: definition.title,
      valueMode: definition.valueMode,
      percentBps,
      coverage: definition.coverage,
      originalCents: priceCents,
      discountCents,
      discountedCents: Math.max(0, priceCents - discountCents),
    }
    if (!best || candidate.discountCents > best.discountCents) best = candidate
  }
  return best
}

export async function GET(req: NextRequest) {
  if (!scholarshipOrganizationEnabled()) {
    return NextResponse.json({ enabled: false, campaigns: [], generalOffer: null }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const programId = req.nextUrl.searchParams.get('programId')
  if (programId) {
    const [campaigns, generalOffer] = await Promise.all([
      campaignsForProgram(programId),
      generalOfferForProgram(programId).catch(() => null),
    ])
    return NextResponse.json({ enabled: true, campaigns, generalOffer }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'يلزم تسجيل الدخول' }, { status: 401 })
  const admissions = await db.admissionApplication.findMany({
    where: { userId: user.id },
    select: { id: true, programId: true },
  })
  const campaigns: any[] = []
  const generalOffers: any[] = []
  for (const admission of admissions) {
    if (!admission.programId) continue
    for (const campaign of await campaignsForProgram(admission.programId)) {
      const entry = await db.scholarshipWaitlistEntry.findUnique({
        where: { definitionId_userId: { definitionId: campaign.definitionId, userId: user.id } },
        select: { status: true },
      })
      campaigns.push({ ...campaign, programId: admission.programId, admissionId: admission.id, waitlistStatus: entry?.status || null })
    }
    const generalOffer = await generalOfferForProgram(admission.programId).catch(() => null)
    if (generalOffer) generalOffers.push({ ...generalOffer, programId: admission.programId, admissionId: admission.id })
  }
  return NextResponse.json({ enabled: true, campaigns, generalOffers }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'يلزم تسجيل الدخول' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || '')
  const definitionId = String(body.definitionId || '')
  try {
    if (action === 'JOIN') {
      const entry = await joinScholarshipWaitlist(db, {
        userId: user.id,
        admissionId: String(body.admissionId || ''),
        definitionId,
      })
      return NextResponse.json({ entry: { id: entry.id, status: entry.status, createdAt: entry.createdAt } })
    }
    if (action === 'LEAVE') {
      const entry = await leaveScholarshipWaitlist(db, { userId: user.id, definitionId })
      return NextResponse.json({ entry: entry ? { id: entry.id, status: entry.status } : null })
    }
    return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    if (e instanceof WaitlistError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
    }
    console.error('scholarship waitlist action failed', e)
    return NextResponse.json({ error: 'تعذر تنفيذ طلب قائمة الانتظار' }, { status: 500 })
  }
}
