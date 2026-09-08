import { db } from '@/lib/db'
import { cookies, headers } from 'next/headers'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto'

const SESSION_COOKIE = 'aact_session'
const SESSION_DAYS = 30

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':')
    const hashBuf = Buffer.from(hash, 'hex')
    const testBuf = scryptSync(password, salt, 64)
    return timingSafeEqual(hashBuf, testBuf)
  } catch {
    return false
  }
}

export async function createSession(userId: string) {
  const token = createHash('sha256')
    .update(randomBytes(32))
    .update(userId)
    .digest('hex')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await db.session.create({ data: { token, userId, expiresAt } })
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
  return token
}

// قراءة رمز الجلسة من الترويسة أولاً (Authorization: Bearer) ثم من الكوكيز
// ترويسة Bearer ضرورية لأن بعض البيئات (iframe / حجب كوكيز الطرف الثالث / تطبيق أندرويد)
// تحجب كوكيز الجلسة، فنعتمد عليها كقناة أساسية والكوكيز كاحتياطي
async function getSessionToken(): Promise<string | null> {
  try {
    const h = await headers()
    const auth = h.get('authorization')
    if (auth?.toLowerCase().startsWith('bearer ')) {
      const t = auth.slice(7).trim()
      if (t) return t
    }
  } catch {}
  try {
    const store = await cookies()
    return store.get(SESSION_COOKIE)?.value ?? null
  } catch {
    return null
  }
}

export async function destroySession() {
  const token = await getSessionToken()
  if (token) {
    await db.session.deleteMany({ where: { token } }).catch(() => {})
  }
  try {
    const store = await cookies()
    store.delete(SESSION_COOKIE)
  } catch {}
}

export async function getCurrentUser() {
  try {
    const token = await getSessionToken()
    if (!token) return null
    const session = await db.session.findUnique({
      where: { token },
      include: { user: true },
    })
    if (!session) return null
    if (session.expiresAt < new Date()) {
      await db.session.delete({ where: { id: session.id } }).catch(() => {})
      return null
    }
    return session.user
  } catch {
    return null
  }
}

export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) throw new Error('UNAUTHORIZED')
  return user
}

export async function requireAdmin() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'ADMIN') throw new Error('UNAUTHORIZED')
  return user
}
