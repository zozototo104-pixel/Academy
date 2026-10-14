import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { serializeRepresentativeExpanded, serializeRepresentativePublicCard, verifyRepresentativeLast4 } from '@/lib/academy-representatives'

type DbLike = any

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

function ipFrom(req: NextRequest) {
  return (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown').split(',')[0].trim() || 'unknown'
}

function safeHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function rateKey(token: string, ip: string) {
  return `token=${safeHash(token)} ip=${safeHash(ip)}`
}

async function auditAttempt(dbClient: DbLike, action: string, token: string, ip: string, entityId?: string | null, extra = '') {
  await dbClient.auditLog.create({
    data: {
      actorName: 'زائر تحقق QR',
      action,
      entity: 'AcademyRepresentative',
      entityId: entityId || null,
      details: `${rateKey(token, ip)}${extra ? ` ${extra}` : ''}`.slice(0, 1000),
    },
  }).catch(() => {})
}

async function rateLimited(dbClient: DbLike, action: string, token: string, ip: string, limit: number) {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const count = await dbClient.auditLog.count({
    where: {
      action,
      entity: 'AcademyRepresentative',
      createdAt: { gte: since },
      details: { contains: rateKey(token, ip) },
    },
  }).catch(() => 0)
  return count >= limit
}

async function findRepresentative(dbClient: DbLike, token: string) {
  return dbClient.academyRepresentative.findFirst({
    where: { qrToken: token, deletedAt: null },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  }).catch(() => null)
}

export async function handleRepresentativeVerifyGet(req: NextRequest, token: string, dbClient: DbLike) {
  const ip = ipFrom(req)
  if (await rateLimited(dbClient, 'REPRESENTATIVE_VERIFY_GET_ATTEMPT', token, ip, 120)) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'حاول لاحقاً.' }, { status: 429 })
  }
  await auditAttempt(dbClient, 'REPRESENTATIVE_VERIFY_GET_ATTEMPT', token, ip)

  const rep = await findRepresentative(dbClient, token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND', message: 'هذا الرمز غير مسجل لدى الأكاديمية' }, { status: 404 })

  return NextResponse.json({
    representative: serializeRepresentativePublicCard(rep, originFrom(req)),
  })
}

export async function handleRepresentativeVerifyPost(req: NextRequest, token: string, dbClient: DbLike) {
  const ip = ipFrom(req)
  if (await rateLimited(dbClient, 'REPRESENTATIVE_VERIFY_POST_ATTEMPT', token, ip, 5)) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'البيانات غير صحيحة' }, { status: 429 })
  }
  await auditAttempt(dbClient, 'REPRESENTATIVE_VERIFY_POST_ATTEMPT', token, ip)

  const body = await req.json().catch(() => ({}))
  const last4 = String(body.last4 || '').trim()
  const rep = await findRepresentative(dbClient, token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND', message: 'هذا الرمز غير مسجل لدى الأكاديمية' }, { status: 404 })

  const ok = verifyRepresentativeLast4(last4, rep.verifyPhoneLast4Hash, rep.verifyEmailLast4Hash)
  if (!ok) {
    await auditAttempt(dbClient, 'VERIFY_REPRESENTATIVE_CARD_FAILED', token, ip, rep.id, `last4Length=${last4.length}`)
    return NextResponse.json({ error: 'INVALID_LAST4', message: 'البيانات غير صحيحة' }, { status: 403 })
  }

  await auditAttempt(dbClient, 'VERIFY_REPRESENTATIVE_CARD_SUCCESS', token, ip, rep.id)
  return NextResponse.json({
    verified: true,
    representative: serializeRepresentativeExpanded(rep, originFrom(req)),
  })
}
