import { createHmac } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { unsealSettingSecret } from '@/lib/secret-crypto'
import { canEnterDefenseRoom, defenseGuestInviteProblem, findInviteByToken } from '@/lib/defense-invites'

// GET /api/webrtc/config?thesisId=... — خوادم ICE/TURN لقاعات الفيديو كونفرنس
// STUN متاح للمستخدم المسجل، أما TURN فيُعاد فقط لمن يملك حق دخول قاعة مناقشة محددة.
// يفضل ضبط TURN_REST_SECRET أو TURN_SHARED_SECRET لاستخدام بيانات TURN مؤقتة (coturn REST API).
// في حال عدم توفر REST secret يبقى دعم TURN_USERNAME/TURN_CREDENTIAL القديم مقيداً بالقاعة فقط للتوافق.
const DEFAULT_STUNS = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
const DEFAULT_TURN_TTL_SECONDS = 15 * 60

type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>

function settingEnv(map: Record<string, string>, key: string): string {
  try {
    return (map[key] || process.env[key] || '').trim()
  } catch {
    return (map[key] || '').trim()
  }
}

function parseStunUrls(value: string) {
  return (value || DEFAULT_STUNS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function ttlSeconds(value: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_TTL_SECONDS
  return Math.max(60, Math.min(3600, Math.floor(parsed)))
}

async function canUseDefenseRoomTurn(thesisId: string, user: CurrentUser): Promise<boolean> {
  const thesis = await db.thesisSubmission.findUnique({
    where: { id: thesisId },
    select: { id: true, userId: true },
  })
  if (!thesis) return false
  // نفس بوابة القاعة: أدمن، الطالب صاحب البحث، أو مشرفه المسند فقط
  return canEnterDefenseRoom(thesis, user)
}

function buildTemporaryTurnCredentials(secret: string, userId: string, thesisId: string, ttl: number) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const username = `${expiresAt}:aact:${userId}:${thesisId}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential, expiresAt }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    const inviteToken = req.nextUrl.searchParams.get('inviteToken')?.trim() || ''
    let guestInvite: any = null
    if (!user) {
      if (!inviteToken) return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
      // ضيف مدعو: رمز الدعوة الصالح لهذه الأطروحة هو الاعتماد
      const thesisIdParam = req.nextUrl.searchParams.get('thesisId')?.trim() || ''
      guestInvite = await findInviteByToken(db as any, inviteToken)
      if (defenseGuestInviteProblem(guestInvite) || guestInvite.thesisId !== thesisIdParam) {
        return NextResponse.json({ error: 'رابط الدعوة غير صالح أو منتهٍ أو ملغي' }, { status: 403 })
      }
    }

    const rows = await db.setting.findMany({
      where: {
        key: {
          in: [
            'TURN_URL',
            'TURN_TCP_URL',
            'TURN_USERNAME',
            'TURN_CREDENTIAL',
            'TURN_REST_SECRET',
            'TURN_SHARED_SECRET',
            'TURN_TTL_SECONDS',
            'STUN_URLS',
          ],
        },
      },
    })
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value

    const turnUrl = settingEnv(map, 'TURN_URL')
    const turnTcp = settingEnv(map, 'TURN_TCP_URL')
    const turnUser = settingEnv(map, 'TURN_USERNAME')
    // الأسرار المحفوظة من لوحة الإعدادات مشفرة (enc:v1:) — تُفك قبل الاستخدام
    const turnPass = unsealSettingSecret(settingEnv(map, 'TURN_CREDENTIAL'))
    const turnRestSecret = unsealSettingSecret(settingEnv(map, 'TURN_REST_SECRET')) || unsealSettingSecret(settingEnv(map, 'TURN_SHARED_SECRET'))
    const ttl = ttlSeconds(settingEnv(map, 'TURN_TTL_SECONDS'))
    const stuns = parseStunUrls(settingEnv(map, 'STUN_URLS'))
    const iceServers: RTCIceServer[] = [{ urls: stuns }]

    const thesisId = req.nextUrl.searchParams.get('thesisId')?.trim() || ''
    const authorizedForTurn = guestInvite
      ? guestInvite.thesisId === thesisId
      : !!thesisId && !!user && (await canUseDefenseRoomTurn(thesisId, user))
    const credentialSubject = guestInvite ? `guest:${guestInvite.id}` : user?.id || ''

    if (turnUrl && authorizedForTurn) {
      const urls = turnTcp ? [turnUrl, turnTcp] : [turnUrl]
      if (turnRestSecret) {
        const temp = buildTemporaryTurnCredentials(turnRestSecret, credentialSubject, thesisId, ttl)
        iceServers.push({ urls, username: temp.username, credential: temp.credential })
        return NextResponse.json(
          { iceServers, hasTurn: true, iceTransportPolicy: 'all', turnAuth: 'TEMPORARY', turnExpiresAt: temp.expiresAt },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      }
      if (turnUser && turnPass) {
        iceServers.push({ urls, username: turnUser, credential: turnPass })
        return NextResponse.json(
          { iceServers, hasTurn: true, iceTransportPolicy: 'all', turnAuth: 'STATIC_LEGACY' },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      }
    }

    return NextResponse.json(
      { iceServers, hasTurn: false, iceTransportPolicy: 'all' },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e) {
    console.error('webrtc config error:', e)
    return NextResponse.json(
      { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], hasTurn: false, iceTransportPolicy: 'all' },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
