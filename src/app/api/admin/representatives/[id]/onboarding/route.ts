import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { createRepresentativeOnboardingToken, hashRepresentativeOnboardingToken } from '@/lib/academy-representatives'
import { emailRepresentativeOnboardingInvitationDetailed } from '@/lib/mailer'

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

function addDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

async function sendOnboardingEmail(to: string, input: Parameters<typeof emailRepresentativeOnboardingInvitationDetailed>[1]) {
  const status = await emailRepresentativeOnboardingInvitationDetailed(to, input)
  return {
    sent: status === 'SENT',
    status,
    failureReason: status === 'SENT' ? null : status === 'SKIPPED' ? 'EMAIL_DELIVERY_SKIPPED_OR_NOT_CONFIGURED' : 'EMAIL_DELIVERY_FAILED',
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const status = String(representative.status || '').toUpperCase()
  if (['SUSPENDED', 'REVOKED'].includes(status)) {
    return NextResponse.json(
      { error: 'لا يمكن إنشاء رابط استكمال لممثل موقوف أو ملغي الاعتماد. أعد تفعيل السجل أولاً ثم أنشئ رابطاً جديداً.' },
      { status: 409 }
    )
  }

  const token = createRepresentativeOnboardingToken()
  const expiresAt = addDays(7)
  const url = `${appBaseUrl()}/representatives/onboarding/${encodeURIComponent(token)}`

  const updated = await db.academyRepresentative.update({
    where: { id },
    data: {
      onboardingToken: null,
      onboardingTokenHash: hashRepresentativeOnboardingToken(token),
      onboardingExpiresAt: expiresAt,
      onboardingStatus: ['SUBMITTED', 'SUBMITTED_REVIEW', 'APPROVED'].includes(representative.onboardingStatus || '') ? representative.onboardingStatus : 'INVITED',
    },
    select: { id: true, onboardingStatus: true, fullName: true, email: true, country: true, territory: true, cardNumber: true, onboardingExpiresAt: true },
  })

  let emailSent = false
  let emailStatus: 'SENT' | 'FAILED' | 'SKIPPED' = 'SKIPPED'
  let emailFailureReason: string | null = updated.email && updated.email.includes('@') ? null : 'NO_REPRESENTATIVE_EMAIL'
  if (updated.email && updated.email.includes('@')) {
    try {
      const delivery = await sendOnboardingEmail(updated.email, {
        name: updated.fullName,
        country: updated.country,
        territory: updated.territory,
        contractNo: updated.cardNumber,
        onboardingUrl: url,
      })
      const sent = delivery.sent
      emailStatus = sent ? 'SENT' : 'FAILED'
      if (delivery.status === 'SKIPPED') emailStatus = 'SKIPPED'
      emailSent = sent
      emailFailureReason = delivery.failureReason
    } catch (error) {
      emailStatus = 'FAILED'
      emailSent = false
      emailFailureReason = String((error as any)?.message || error || 'EMAIL_DELIVERY_FAILED').slice(0, 400)
      console.warn('Failed to send representative onboarding invitation.', error)
    }
  }

  await audit(user.id, 'CREATE_REPRESENTATIVE_ONBOARDING_LINK', id, `${representative.fullName} — expires=${expiresAt.toISOString()} — email=${emailStatus}`)
  return NextResponse.json({
    onboardingStatus: updated.onboardingStatus,
    expiresAt: updated.onboardingExpiresAt,
    emailSent,
    emailStatus,
    emailFailureReason,
    url,
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  await db.academyRepresentative.update({ where: { id }, data: { onboardingToken: null, onboardingTokenHash: null, onboardingExpiresAt: null, onboardingStatus: 'NOT_SENT' } })
  await audit(user.id, 'REVOKE_REPRESENTATIVE_ONBOARDING_LINK', id, representative.fullName)
  return NextResponse.json({ ok: true })
}
