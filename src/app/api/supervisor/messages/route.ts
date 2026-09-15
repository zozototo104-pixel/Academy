import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'

async function getAccessibleAdmission(admissionId: string, user: any) {
  const app = await db.admissionApplication.findUnique({
    where: { id: admissionId },
    include: { supervisor: { select: { id: true, name: true } } },
  })
  if (!app) return null
  const isStudentOwner = user.role === 'STUDENT' && (app.userId === user.id || app.email?.toLowerCase() === user.email?.toLowerCase())
  const isSupervisor = user.role === 'SUPERVISOR' && app.supervisorId === user.id
  const isAdmin = user.role === 'ADMIN'
  if (!isStudentOwner && !isSupervisor && !isAdmin) return null
  return app
}

function senderRole(user: any) {
  if (user.role === 'SUPERVISOR') return 'SUPERVISOR'
  if (user.role === 'ADMIN') return 'ADMIN'
  return 'STUDENT'
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const admissionId = req.nextUrl.searchParams.get('admissionId') || ''
    if (!admissionId) return NextResponse.json({ error: 'معرّف الطالب/الطلب مطلوب' }, { status: 400 })
    const app = await getAccessibleAdmission(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية قراءة هذه المحادثة' }, { status: 403 })
    const messages = await db.supervisorChannelMessage.findMany({
      where: { admissionId },
      orderBy: { createdAt: 'asc' },
      take: 250,
    })
    return NextResponse.json({ messages })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor messages GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المحادثة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const admissionId = String(body.admissionId || '')
    const content = String(body.content || '').trim()
    const mode = String(body.mode || 'TEXT').toUpperCase() === 'VOICE' ? 'VOICE' : 'TEXT'
    const audioData = String(body.audioData || '').trim()
    const audioMime = String(body.audioMime || '').trim()
    if (!admissionId) return NextResponse.json({ error: 'معرّف الطالب/الطلب مطلوب' }, { status: 400 })
    if (!content && !audioData) return NextResponse.json({ error: 'اكتب رسالة أو أرسل ملاحظة صوتية' }, { status: 400 })
    if (audioData && audioData.length > 2_000_000) return NextResponse.json({ error: 'الملاحظة الصوتية كبيرة جداً. أرسل تسجيلاً أقصر.' }, { status: 400 })
    const app = await getAccessibleAdmission(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية إرسال رسالة لهذا الطالب' }, { status: 403 })
    const msg = await db.supervisorChannelMessage.create({
      data: {
        admissionId,
        studentId: app.userId || user.id,
        supervisorId: app.supervisorId || null,
        senderId: user.id,
        senderRole: senderRole(user),
        mode,
        content: content || 'ملاحظة صوتية',
        audioData: audioData || null,
        audioMime: audioMime || null,
      },
    })
    if (user.role === 'STUDENT') {
      await notify(app.supervisorId || null, 'SUPERVISION', 'رسالة جديدة من طالب', `${app.fullName}: ${content || 'أرسل ملاحظة صوتية'}`, 'supervisor')
    } else {
      await notify(app.userId || null, 'SUPERVISION', 'رسالة من مشرفك الأكاديمي', content || 'أرسل مشرفك ملاحظة صوتية', 'dashboard')
    }
    return NextResponse.json({ ok: true, message: msg })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor messages POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر إرسال الرسالة' }, { status: 500 })
  }
}
