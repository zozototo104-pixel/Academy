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
  const definitions = await db.scholarshipDefinition.findMany({
    where: { active: true, programs: { some: { programId } } },
    include: { programs: { select: { programId: true, seats: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const now = Date.now()
  const campaigns = []
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

export async function GET(req: NextRequest) {
  if (!scholarshipOrganizationEnabled()) {
    return NextResponse.json({ enabled: false, campaigns: [] }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const programId = req.nextUrl.searchParams.get('programId')
  if (programId) {
    const campaigns = await campaignsForProgram(programId)
    return NextResponse.json({ enabled: true, campaigns }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'يلزم تسجيل الدخول' }, { status: 401 })
  const admissions = await db.admissionApplication.findMany({
    where: { userId: user.id },
    select: { id: true, programId: true },
  })
  const campaigns = []
  for (const admission of admissions) {
    if (!admission.programId) continue
    for (const campaign of await campaignsForProgram(admission.programId)) {
      const entry = await db.scholarshipWaitlistEntry.findUnique({
        where: { definitionId_userId: { definitionId: campaign.definitionId, userId: user.id } },
        select: { status: true },
      })
      campaigns.push({ ...campaign, programId: admission.programId, admissionId: admission.id, waitlistStatus: entry?.status || null })
    }
  }
  return NextResponse.json({ enabled: true, campaigns }, { headers: { 'Cache-Control': 'no-store' } })
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
