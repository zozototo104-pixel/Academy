import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isAssignedStudent } from '@/lib/supervisor-scope'

// دعوات المناقشين الخارجيين لقاعة المناقشة + بوابة دخول القاعة.
// قرار حارس 2026-10-30: حاضرون المناقشة هم مشرف الطالب الخاص + مناقشون خارجيون
// يُستدعَون بروابط دعوة شخصية (حتى بلا حساب بالمنصة) + المناقش الذكي.
// الرابط سرّي بحد ذاته: يُخزَّن هاشه فقط، ويُعرض النصي مرة واحدة عند الإنشاء.

export function hashDefenseToken(value: string): string {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

export function generateDefenseGuestToken(): string {
  return randomBytes(32).toString('base64url')
}

export function issueGuestSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString('base64url')
  return { secret, secretHash: hashDefenseToken(secret) }
}

export function verifyGuestSecret(storedHash: string | null | undefined, presented: string | null | undefined): boolean {
  if (!storedHash || !presented) return false
  const a = Buffer.from(storedHash)
  const b = Buffer.from(hashDefenseToken(presented))
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function findInviteByToken(db: any, token: string) {
  const clean = String(token || '').trim()
  if (!clean) return null
  return db.defenseGuestInvite.findUnique({ where: { tokenHash: hashDefenseToken(clean) } })
}

export function defenseGuestInviteProblem(invite: any): 'NOT_FOUND' | 'REVOKED' | 'EXPIRED' | null {
  if (!invite) return 'NOT_FOUND'
  if (invite.revokedAt) return 'REVOKED'
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'EXPIRED'
  return null
}

export async function createDefenseGuestInvite(
  db: any,
  input: { thesisId: string; name: string; role?: string; expiresAt: Date; createdById?: string | null },
): Promise<{ invite: any; token: string }> {
  const token = generateDefenseGuestToken()
  const invite = await db.defenseGuestInvite.create({
    data: {
      thesisId: input.thesisId,
      name: input.name,
      role: input.role === 'AGENT' ? 'AGENT' : 'COMMITTEE',
      tokenHash: hashDefenseToken(token),
      expiresAt: input.expiresAt,
      createdById: input.createdById ?? null,
    },
  })
  return { invite, token }
}

// بوابة دخول قاعة المناقشة لمستخدمي المنصة:
// الأدمن دائماً، الطالب لقاعته فقط، المشرف لطلابه المسندين فقط — الباقي عبر دعوة ضيف.
export async function canEnterDefenseRoom(thesis: { userId: string }, user: { id: string; role: string; name?: string | null }): Promise<boolean> {
  if (user.role === 'ADMIN') return true
  if (user.role === 'STUDENT') return thesis.userId === user.id
  if (user.role === 'SUPERVISOR') return isAssignedStudent({ id: user.id, name: user.name ?? null, role: user.role } as any, thesis.userId)
  return false
}
