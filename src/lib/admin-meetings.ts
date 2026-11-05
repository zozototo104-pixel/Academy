import { createHash, randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, hasSecretEncryptionKey } from '@/lib/secret-crypto'

// ===== قاعة الاجتماعات الإدارية — المنطق المشترك =====
// الأنماط معاد استخدامها من أنظمة مجرّبة في المنصة: رموز الدعوة من
// دعوات المناقشة (هاش SHA-256 هو الاعتماد الوحيد للتحقق)، ونافذة
// الدخول من لقاءات الطلاب (تفتح قبل البدء بـ15 دقيقة بالضبط وتُفرض
// من الخادم)، والحالة الفعلية مشتقة من الساعة لا مخزّنة. إلى جانب
// الهاش تُحفظ نسخة مشفّرة من الرمز (tokenSealed) حتى تستطيع الإدارة
// إعادة عرض الرابط ونسخه من صفحة التفاصيل في أي وقت؛ بلا مفتاح
// تشفير مضبوط في الخادم تبقى النسخة فارغة ويبقى الرابط «مرة واحدة».

export const MEETING_JOIN_WINDOW_MINUTES = 15
export const MEETING_PROVIDERS = ['ZOOM', 'MEET', 'TEAMS', 'OTHER', 'PLATFORM'] as const
export type MeetingProvider = (typeof MEETING_PROVIDERS)[number]

export function hashMeetingToken(value: string): string {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

export function generateMeetingToken(): string {
  return randomBytes(32).toString('base64url')
}

export function meetingInviteUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  if (!base) throw new Error('NEXT_PUBLIC_APP_URL is not configured')
  return `${base}/meetings/${token}`
}

// تشفير رمز الدعوة لحفظه بجانب الهاش (لعرض الإدارة لاحقًا). بلا
// مفتاح تشفير في بيئة الخادم يعيد null — لا يُحفظ النص الخام أبدًا.
export function sealMeetingToken(token: string): string | null {
  if (!hasSecretEncryptionKey()) return null
  try {
    return encryptSecret(token)
  } catch {
    return null
  }
}

// رابط الدعوة الكامل من النسخة المشفّرة — لمسارات الإدارة حصرًا.
// دعوة قديمة بلا نسخة مشفّرة (أو فشل فكّها) يعيد null.
export function meetingInviteUrlForInvite(invite: { tokenSealed?: string | null } | null | undefined): string | null {
  const sealed = invite?.tokenSealed
  if (!sealed) return null
  try {
    return meetingInviteUrl(decryptSecret(sealed))
  } catch {
    return null
  }
}

export type MeetingTimes = { startsAt: Date | string; endsAt: Date | string; status: string }
export type EffectiveMeetingStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED'

export function deriveMeetingStatus(meeting: MeetingTimes, now: Date = new Date()): EffectiveMeetingStatus {
  if (meeting.status === 'CANCELLED') return 'CANCELLED'
  const start = new Date(meeting.startsAt).getTime()
  const end = new Date(meeting.endsAt).getTime()
  if (now.getTime() < start) return 'SCHEDULED'
  if (now.getTime() <= end) return 'LIVE'
  return 'ENDED'
}

export function meetingJoinOpensAt(meeting: MeetingTimes): Date {
  return new Date(new Date(meeting.startsAt).getTime() - MEETING_JOIN_WINDOW_MINUTES * 60_000)
}

// الدخول يفتح قبل البدء بـ15 دقيقة بالضبط ويبقى حتى نهاية الاجتماع؛
// الملغى لا يفتح أبدًا. يُفرض من الخادم في كل مسار كشف/دخول.
export function isMeetingJoinOpen(meeting: MeetingTimes, now: Date = new Date()): boolean {
  if (meeting.status === 'CANCELLED') return false
  return now.getTime() >= meetingJoinOpensAt(meeting).getTime() && now.getTime() <= new Date(meeting.endsAt).getTime()
}

export function meetingInviteProblem(
  invite: { revokedAt?: Date | string | null; expiresAt: Date | string } | null | undefined,
  now: Date = new Date(),
): 'NOT_FOUND' | 'REVOKED' | 'EXPIRED' | null {
  if (!invite) return 'NOT_FOUND'
  if (invite.revokedAt) return 'REVOKED'
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return 'EXPIRED'
  return null
}

// روابط الفيديو الخارجية: HTTPS حصرًا + مضيف يطابق المزود المعلن.
// PLATFORM لا رابط له (الغرفة الداخلية).
const PROVIDER_HOSTS: Record<string, string[]> = {
  ZOOM: ['zoom.us'],
  MEET: ['meet.google.com'],
  TEAMS: ['teams.microsoft.com', 'teams.live.com'],
}

export function validateMeetingVideo(input: { provider: string; meetingUrl?: string | null }):
  | { ok: true }
  | { ok: false; code: 'PROVIDER_INVALID' | 'URL_REQUIRED' | 'URL_UNSAFE' | 'URL_HOST_MISMATCH' } {
  if (!(MEETING_PROVIDERS as readonly string[]).includes(input.provider)) return { ok: false, code: 'PROVIDER_INVALID' }
  if (input.provider === 'PLATFORM') return { ok: true }
  const raw = String(input.meetingUrl || '').trim()
  if (!raw) return { ok: false, code: 'URL_REQUIRED' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, code: 'URL_UNSAFE' }
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'URL_UNSAFE' }
  const hosts = PROVIDER_HOSTS[input.provider]
  if (hosts) {
    const hostOk = input.provider === 'MEET'
      ? url.hostname === 'meet.google.com'
      : hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))
    if (!hostOk) return { ok: false, code: 'URL_HOST_MISMATCH' }
  }
  return { ok: true }
}


type AnyDb = any

export async function findMeetingInviteByToken(db: AnyDb, token: string) {
  const clean = String(token || '').trim()
  if (!clean) return null
  return db.adminMeetingInvite.findUnique({
    where: { tokenHash: hashMeetingToken(clean) },
    include: { meeting: true },
  }).catch(() => null)
}

// من يحق له رؤية تفاصيل الاجتماع الكاملة ودخوله: الإدارة، أو حامل
// دعوة صالحة استلمها بحسابه. حامل دعوة لم يستلمها بعد لا يرى إلا
// التمهيد العام (العنوان والموعد) — بقية البيانات بعد الاستلام.
export async function meetingAccessFor(db: AnyDb, invite: any, user: { id: string; role?: string } | null) {
  if (!invite?.meeting) return { level: 'NONE' as const }
  if (user?.role === 'ADMIN') return { level: 'FULL' as const }
  if (!user) return { level: 'TEASER' as const }
  if (invite.claimedByUserId && invite.claimedByUserId !== user.id) return { level: 'NONE' as const }
  if (invite.claimedByUserId === user.id) return { level: 'FULL' as const }
  return { level: 'CLAIMABLE' as const }
}

// إعادة إصدار رابط دعوة (للدعوات القديمة بلا نسخة مشفّرة، أو عند
// الحاجة): رمز جديد يحل محل القديم — الهاش والنسخة المشفّرة معًا —
// فيموت الرابط القديم فورًا. تُرفض للدعوة المستلَمة (صاحبها دخل
// بها أصلًا وإبطالها يكسر جلسته) وللملغاة (تُضاف دعوة جديدة بدلًا).
export async function rotateMeetingInviteToken(db: AnyDb, invite: any):
  Promise<{ ok: true; url: string } | { ok: false; code: 'ALREADY_CLAIMED' | 'INVITE_REVOKED' }> {
  if (invite.claimedByUserId) return { ok: false, code: 'ALREADY_CLAIMED' }
  if (invite.revokedAt) return { ok: false, code: 'INVITE_REVOKED' }
  const token = generateMeetingToken()
  await db.adminMeetingInvite.update({
    where: { id: invite.id },
    data: { tokenHash: hashMeetingToken(token), tokenSealed: sealMeetingToken(token) },
  })
  return { ok: true, url: meetingInviteUrl(token) }
}

// شكل دعوة كما يظهر في تفاصيل اجتماع الإدارة: يشمل الرابط الكامل
// (من النسخة المشفّرة) — ولا يُستخدم إلا خلف بوابة الإدارة.
export function adminInviteShape(invite: any, claimedByName: string | null, now: Date = new Date()) {
  return {
    id: invite.id,
    inviteeName: invite.inviteeName,
    inviteeEmail: invite.inviteeEmail,
    url: meetingInviteUrlForInvite(invite),
    claimed: Boolean(invite.claimedByUserId),
    claimedByName,
    opened: Boolean(invite.lastOpenedAt),
    revoked: Boolean(invite.revokedAt),
    expired: new Date(invite.expiresAt).getTime() <= now.getTime(),
    createdAt: invite.createdAt,
  }
}

// استلام الدعوة: يربطها بحساب المستخدم. دعوة مستلَمة من غيره لا
// تُسرق؛ الاستلام الذرّي المشروط يمنع سباق حسابين على نفس الدعوة.
export async function claimMeetingInvite(db: AnyDb, invite: any, userId: string) {
  if (invite.claimedByUserId === userId) return { ok: true as const }
  if (invite.claimedByUserId) return { ok: false as const, code: 'CLAIMED_BY_OTHER' }
  const updated = await db.adminMeetingInvite.updateMany({
    where: { id: invite.id, claimedByUserId: null },
    data: { claimedByUserId: userId, claimedAt: new Date(), lastOpenedAt: new Date() },
  }).catch(() => null)
  if (!updated || updated.count !== 1) return { ok: false as const, code: 'CLAIMED_BY_OTHER' }
  return { ok: true as const }
}
