import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { hashRepresentativeVerifier, normalizeRepresentativeSlug, representativeQrDataUrl, serializeRepresentative } from '@/lib/academy-representatives'
import { emailRepresentativeProfileApproved } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

function text(value: unknown, max = 4000) {
  return String(value ?? '').trim().slice(0, max) || null
}

function bool(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function int(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

async function uniqueSlug(base: string, excludeId: string) {
  const clean = normalizeRepresentativeSlug(base)
  for (let i = 0; i < 20; i += 1) {
    const slug = i === 0 ? clean : `${clean}-${i + 1}`
    const existing = await db.academyRepresentative.findUnique({ where: { slug }, select: { id: true } }).catch(() => null)
    if (!existing || existing.id === excludeId) return slug
  }
  return `${clean}-${Date.now().toString(36)}`
}

async function audit(actorId: string, action: string, entityId: string, details: string) {
  await db.auditLog.create({
    data: { actorId, actorName: 'إدارة النظام', action, entity: 'AcademyRepresentative', entityId, details: details.slice(0, 3900) },
  }).catch(() => {})
}

function dataFromBody(body: any) {
  const data: any = {
    status: text(body.status, 30) || 'ACTIVE',
    fullName: text(body.fullName, 220),
    displayTitle: text(body.displayTitle, 260),
    degreeTitle: text(body.degreeTitle, 220),
    academicRank: text(body.academicRank, 160),
    country: text(body.country, 120),
    region: text(body.region, 160),
    territory: text(body.territory, 260),
    city: text(body.city, 120),
    specialization: text(body.specialization, 260),
    representativeRole: text(body.representativeRole, 80) || 'COUNTRY_REPRESENTATIVE',
    shortBio: text(body.shortBio, 700),
    rawBio: text(body.rawBio, 12000),
    professionalBio: text(body.professionalBio, 12000),
    worksSummary: text(body.worksSummary, 5000),
    achievements: text(body.achievements, 5000),
    publicContactNote: text(body.publicContactNote, 1200),
    phone: text(body.phone, 80),
    email: text(body.email, 180),
    whatsapp: text(body.whatsapp, 80),
    website: text(body.website, 400),
    featured: bool(body.featured),
    sortOrder: int(body.sortOrder, 0),
  }
  return data
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const current = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!current) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const data = dataFromBody(body)
  const fullName = data.fullName
  const country = data.country
  const region = data.region
  if (!fullName || !country || !region) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', message: 'الاسم والدولة والمنطقة الجغرافية مطلوبة.' }, { status: 400 })
  }
  const slug = await uniqueSlug(String(body.slug || fullName), id)
  const approvingForPublic = current.status !== 'ACTIVE' && data.status === 'ACTIVE'
  const updated = await db.academyRepresentative.update({
    where: { id },
    data: {
      ...data,
      fullName,
      country,
      region,
      slug,
      onboardingStatus: data.status === 'ACTIVE' ? 'APPROVED' : current.onboardingStatus,
      verifyPhoneLast4Hash: hashRepresentativeVerifier(data.phone),
      verifyEmailLast4Hash: hashRepresentativeVerifier(data.email),
      updatedById: user.id,
    },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  })
  await audit(user.id, approvingForPublic ? 'APPROVE_ACADEMY_REPRESENTATIVE_PROFILE' : 'UPDATE_ACADEMY_REPRESENTATIVE', id, `${updated.fullName} — ${updated.country}`)
  const origin = originFrom(req)
  if (approvingForPublic && updated.email) {
    await emailRepresentativeProfileApproved(updated.email, {
      name: updated.fullName,
      profileUrl: `${origin.replace(/\/+$/, '')}/representatives/${updated.slug}`,
    }).catch(() => {})
  }
  return NextResponse.json({
    representative: {
      ...serializeRepresentative(updated, origin, true),
      qrDataUrl: updated.qrToken ? await representativeQrDataUrl(updated.qrToken, origin).catch(() => null) : null,
      rawBio: updated.rawBio,
      aiRewriteStatus: updated.aiRewriteStatus,
      aiRewriteNote: updated.aiRewriteNote,
    },
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const current = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!current) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  await db.academyRepresentative.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED', updatedById: user.id } })
  await audit(user.id, 'DELETE_ACADEMY_REPRESENTATIVE', id, `${current.fullName} — ${current.country}`)
  return NextResponse.json({ ok: true })
}
