import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

// GET /api/webrtc/config — خوادم ICE/TURN لقاعات الفيديو كونفرنس
// يقتصر على المستخدمين المسجلين (حماية بيانات اعتماد TURN)
// الإعداد من لوحة الإدارة (تبويب «البريد والدفع») أو من متغيرات البيئة:
//   TURN_URL=turn:turn.example.com:3478  TURN_TCP_URL=turns:...  TURN_USERNAME  TURN_CREDENTIAL
// بدون TURN: STUN وحده (اتصالات P2P المباشرة) — مع TURN: اجتياز NAT الصارم وشبكات الشركات
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })

    const rows = await db.setting.findMany({
      where: { key: { in: ['TURN_URL', 'TURN_TCP_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'STUN_URLS'] } },
    })
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value

    const env = (k: string) => {
      try {
        return process.env[k] || ''
      } catch {
        return ''
      }
    }
    const turnUrl = map.TURN_URL || env('TURN_URL') || ''
    const turnTcp = map.TURN_TCP_URL || env('TURN_TCP_URL') || ''
    const turnUser = map.TURN_USERNAME || env('TURN_USERNAME') || ''
    const turnPass = map.TURN_CREDENTIAL || env('TURN_CREDENTIAL') || ''
    const stuns = (map.STUN_URLS || env('STUN_URLS') || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const iceServers: any[] = [{ urls: stuns }]
    if (turnUrl && turnUser && turnPass) {
      const urls = turnTcp ? [turnUrl, turnTcp] : [turnUrl]
      iceServers.push({ urls, username: turnUser, credential: turnPass })
    }

    return NextResponse.json({
      iceServers,
      hasTurn: !!(turnUrl && turnUser && turnPass),
      iceTransportPolicy: 'all',
    })
  } catch {
    return NextResponse.json({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      hasTurn: false,
    })
  }
}
