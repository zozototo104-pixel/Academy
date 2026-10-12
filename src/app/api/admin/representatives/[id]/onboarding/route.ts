import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { createRepresentativeOnboardingToken } from '@/lib/academy-representatives'

async function audit(actorId: string, action: string, entityId: string, details: string) {
  await db.auditLog.create({
    data: { actorId, actorName: 'إدارة النظام', action, entity: 'AcademyRepresentative', entityId, details: details.slice(0, 3900) },
  }).catch(() => {})
}

function appBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || process.env.VERCEL_URL || 'http://localhost:3000'
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/$/, '')
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const token = representative.onboardingToken || createRepresentativeOnboardingToken()
  const updated = await db.academyRepresentative.update({
    where: { id },
    data: { onboardingToken: token, onboardingStatus: representative.onboardingStatus === 'SUBMITTED' ? 'SUBMITTED' : 'INVITED' },
    select: { id: true, onboardingToken: true, onboardingStatus: true, fullName: true },
  })
  await audit(user.id, representative.onboardingToken ? 'GET_REPRESENTATIVE_ONBOARDING_LINK' : 'CREATE_REPRESENTATIVE_ONBOARDING_LINK', id, representative.fullName)
  return NextResponse.json({
    token: updated.onboardingToken,
    onboardingStatus: updated.onboardingStatus,
    url: `${appBaseUrl()}/representatives/onboarding/${encodeURIComponent(updated.onboardingToken || token)}`,
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  await db.academyRepresentative.update({ where: { id }, data: { onboardingToken: null, onboardingStatus: 'NOT_SENT' } })
  await audit(user.id, 'REVOKE_REPRESENTATIVE_ONBOARDING_LINK', id, representative.fullName)
  return NextResponse.json({ ok: true })
}
