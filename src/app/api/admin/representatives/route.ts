import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  createRepresentativeQrToken,
  hashRepresentativeVerifier,
  normalizeRepresentativeSlug,
  representativeQrDataUrl,
  representativeVerifyUrl,
  serializeRepresentative,
} from '@/lib/academy-representatives'

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

async function uniqueSlug(base: string, excludeId?: string) {
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
  return {
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
}

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  const rows = await db.academyRepresentative.findMany({
    where: { deletedAt: null },
    orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { updatedAt: 'desc' }],
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  })
  const origin = originFrom(req)
  const representatives = await Promise.all(rows.map(async (row) => ({
    ...serializeRepresentative(row, origin, true),
    qrDataUrl: row.qrToken ? await representativeQrDataUrl(row.qrToken, origin).catch(() => null) : null,
    rawBio: row.rawBio,
    aiRewriteStatus: row.aiRewriteStatus,
    aiRewriteNote: row.aiRewriteNote,
  })))
  await audit(user.id, 'LIST_ACADEMY_REPRESENTATIVES', 'ALL', `count=${representatives.length}`)
  return NextResponse.json({ representatives })
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  const body = await req.json().catch(() => ({}))
  const data = dataFromBody(body)
  if (!data.fullName || !data.country || !data.region) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', message: 'الاسم والدولة والمنطقة الجغرافية مطلوبة.' }, { status: 400 })
  }
  const slug = await uniqueSlug(String(body.slug || data.fullName))
  const qrToken = createRepresentativeQrToken()
  const created = await db.academyRepresentative.create({
    data: {
      ...data,
      slug,
      qrToken,
      verifyPhoneLast4Hash: hashRepresentativeVerifier(data.phone),
      verifyEmailLast4Hash: hashRepresentativeVerifier(data.email),
      createdById: user.id,
      updatedById: user.id,
    },
    include: { files: true },
  })
  await audit(user.id, 'CREATE_ACADEMY_REPRESENTATIVE', created.id, `${created.fullName} — ${created.country}`)
  const origin = originFrom(req)
  return NextResponse.json({
    representative: {
      ...serializeRepresentative(created, origin, true),
      verifyUrl: representativeVerifyUrl(created.qrToken, origin),
      qrDataUrl: await representativeQrDataUrl(created.qrToken, origin).catch(() => null),
      rawBio: created.rawBio,
    },
  })
}
