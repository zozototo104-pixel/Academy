import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import {
  createEmailVerificationToken,
  emailVerificationUrl,
  shouldIssueNewVerification,
} from '@/lib/email-verification'
import { emailEmailChangeConfirm } from '@/lib/mailer'

// Email-change flows (owner decision 2026-10-30):
// - LOGIN: full login-email swap for password accounts. The old email keeps
//   working until the student confirms from the NEW mailbox; the swap also
//   marks the account verified (ownership of the new mailbox is proven).
// - NOTIFICATION: a separate delivery address used by the mailer for all
//   non-identity mail. This is the only flow offered to Google accounts —
//   their login identity stays their Gmail address (Google sign-in matches
//   users by email, so a login swap would orphan the account).
// Google accounts are recognised by User.authProvider, stamped on every
// Google sign-in (and as a second line of defence, a LOGIN swap always
// requires the current password, which Google-created accounts do not know).

export type EmailChangePurpose = 'LOGIN' | 'NOTIFICATION'

export type EmailChangeUser = {
  id: string
  email: string
  name: string
  password: string
  authProvider?: string | null
  notificationEmail?: string | null
  emailVerificationSentAt?: Date | string | null
  emailVerificationExpiresAt?: Date | string | null
}

export type EmailChangeResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

export function normalizeEmail(value: unknown): string {
  return String(value || '').toLowerCase().trim()
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

async function audit(action: string, actor: { id?: string | null; name?: string | null } | null, userId: string, details: string) {
  await db.auditLog
    .create({
      data: {
        actorId: actor?.id || null,
        actorName: actor?.name || null,
        action,
        entity: 'User',
        entityId: userId,
        details,
      },
    })
    .catch(() => {})
}

export async function requestEmailChange(input: {
  req: NextRequest
  user: EmailChangeUser
  newEmail: string
  purpose: EmailChangePurpose
  password?: string
  requestedBy?: { id: string; name: string } | null
}): Promise<EmailChangeResult> {
  const { user, purpose } = input
  const byAdmin = input.requestedBy || null
  const newEmail = normalizeEmail(input.newEmail)

  if (!isValidEmail(newEmail)) {
    return { ok: false, status: 400, code: 'INVALID_EMAIL', message: 'أدخل بريداً إلكترونياً صحيحاً.' }
  }
  if (newEmail === normalizeEmail(user.email)) {
    return { ok: false, status: 400, code: 'SAME_EMAIL', message: 'هذا هو بريد حسابك الحالي أصلاً.' }
  }
  if (purpose === 'NOTIFICATION' && user.notificationEmail && newEmail === normalizeEmail(user.notificationEmail)) {
    return { ok: false, status: 400, code: 'SAME_EMAIL', message: 'هذا هو بريد الإشعارات المعتمد حالياً.' }
  }

  if (purpose === 'LOGIN') {
    if (String(user.authProvider || 'EMAIL') === 'GOOGLE') {
      return {
        ok: false,
        status: 400,
        code: 'GOOGLE_USE_NOTIFICATION',
        message: 'حسابك مرتبط بدخول Google وبريده يبقى كما هو — يمكنك اعتماد بريد إشعارات جديد بدلاً من ذلك.',
      }
    }
    if (!byAdmin) {
      if (!input.password) {
        return { ok: false, status: 400, code: 'PASSWORD_REQUIRED', message: 'أدخل كلمة المرور الحالية لتأكيد الطلب.' }
      }
      const passwordOk = await verifyPassword(input.password, user.password)
      if (!passwordOk) {
        return { ok: false, status: 401, code: 'WRONG_PASSWORD', message: 'كلمة المرور الحالية غير صحيحة.' }
      }
    }
    const taken = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } }).catch(() => null)
    if (taken) {
      return { ok: false, status: 409, code: 'EMAIL_TAKEN', message: 'هذا البريد مستخدم في حساب آخر.' }
    }
  }

  if (!shouldIssueNewVerification(user)) {
    return { ok: false, status: 429, code: 'TOO_SOON', message: 'أرسلنا رابطاً قبل قليل — انتظر 10 دقائق ثم حاول مجدداً.' }
  }

  const token = createEmailVerificationToken()
  await db.user.update({
    where: { id: user.id },
    data: {
      pendingEmail: newEmail,
      pendingEmailPurpose: purpose,
      emailVerificationTokenHash: token.tokenHash,
      emailVerificationExpiresAt: token.expiresAt,
      emailVerificationSentAt: new Date(),
    } as any,
  })

  await emailEmailChangeConfirm(newEmail, user.name, emailVerificationUrl(input.req, token.token), purpose).catch(() => false)
  await audit('EMAIL_CHANGE_REQUESTED', byAdmin || { id: user.id, name: user.name }, user.id, JSON.stringify({ purpose, newEmail, byAdmin: !!byAdmin }))
  return { ok: true }
}

export async function cancelPendingEmailChange(userId: string) {
  await db.user.update({
    where: { id: userId },
    data: {
      pendingEmail: null,
      pendingEmailPurpose: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationSentAt: null,
    } as any,
  })
}

export type PendingApplyOutcome =
  | { outcome: 'LOGIN_APPLIED'; oldEmail: string; newEmail: string }
  | { outcome: 'NOTIFICATION_APPLIED'; newEmail: string }
  | { outcome: 'EMAIL_TAKEN' }

// Called by the verify-email route when the matched user carries a pending
// email change. Applies the change atomically from the stored pending fields.
export async function applyPendingEmailChange(user: {
  id: string
  email: string
  pendingEmail?: string | null
  pendingEmailPurpose?: string | null
}): Promise<PendingApplyOutcome> {
  const newEmail = normalizeEmail(user.pendingEmail)
  const purpose = String(user.pendingEmailPurpose || 'NOTIFICATION') as EmailChangePurpose

  if (purpose === 'LOGIN') {
    const taken = await db.user.findUnique({ where: { email: newEmail }, select: { id: true } }).catch(() => null)
    if (taken && taken.id !== user.id) {
      await cancelPendingEmailChange(user.id)
      return { outcome: 'EMAIL_TAKEN' }
    }
    await db.user.update({
      where: { id: user.id },
      data: {
        email: newEmail,
        emailVerifiedAt: new Date(),
        pendingEmail: null,
        pendingEmailPurpose: null,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
        emailVerificationSentAt: null,
      } as any,
    })
    await audit('LOGIN_EMAIL_CHANGED', null, user.id, JSON.stringify({ from: user.email, to: newEmail }))
    return { outcome: 'LOGIN_APPLIED', oldEmail: user.email, newEmail }
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      notificationEmail: newEmail,
      pendingEmail: null,
      pendingEmailPurpose: null,
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationSentAt: null,
    } as any,
  })
  await audit('NOTIFICATION_EMAIL_CHANGED', null, user.id, JSON.stringify({ to: newEmail }))
  return { outcome: 'NOTIFICATION_APPLIED', newEmail }
}
