import { after, NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify, notifyAdmins } from '@/lib/notify'
import { generateSupervisorThreadReply } from '@/lib/supervisor-thread-ai'

const SCOPES = ['SUPERVISION', 'ADMIN'] as const
const AUDIENCES = ['AI', 'HUMAN', 'ALL'] as const

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
    const scope = req.nextUrl.searchParams.get('scope') || 'SUPERVISION'
    if (!(SCOPES as readonly string[]).includes(scope)) return NextResponse.json({ error: 'نطاق المحادثة غير صالح' }, { status: 400 })
    const app = await getAccessibleAdmission(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية قراءة هذه المحادثة' }, { status: 403 })
    // Role rules: admin never reads supervision threads, supervisor never reads admin threads.
    if (user.role === 'ADMIN' && scope === 'SUPERVISION') return NextResponse.json({ error: 'الإدارة لا تدخل محادثات الإشراف' }, { status: 403 })
    if (user.role === 'SUPERVISOR' && scope === 'ADMIN') return NextResponse.json({ error: 'المشرف لا يدخل رسائل الإدارة' }, { status: 403 })
    const messages = await db.supervisorChannelMessage.findMany({
      where: { admissionId, scope },
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
    const scope = String(body.scope || 'SUPERVISION').toUpperCase()
    if (!admissionId) return NextResponse.json({ error: 'معرّف الطالب/الطلب مطلوب' }, { status: 400 })
    if (!(SCOPES as readonly string[]).includes(scope)) return NextResponse.json({ error: 'نطاق المحادثة غير صالح' }, { status: 400 })
    if (!content && !audioData) return NextResponse.json({ error: 'اكتب رسالة أو أرسل ملاحظة صوتية' }, { status: 400 })
    if (audioData && audioData.length > 2_000_000) return NextResponse.json({ error: 'الملاحظة الصوتية كبيرة جداً. أرسل تسجيلاً أقصر.' }, { status: 400 })
    const app = await getAccessibleAdmission(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية إرسال رسالة لهذا الطالب' }, { status: 403 })
    // Role rules: admin stays out of supervision entirely; supervisor never sends admin-scope.
    if (user.role === 'ADMIN' && scope === 'SUPERVISION') return NextResponse.json({ error: 'الإدارة لا تراسل داخل محادثات الإشراف' }, { status: 403 })
    if (user.role === 'SUPERVISOR' && scope === 'ADMIN') return NextResponse.json({ error: 'المشرف لا يراسل داخل رسائل الإدارة' }, { status: 403 })
    if (user.role === 'ADMIN' && scope === 'ADMIN' && !app.userId) return NextResponse.json({ error: 'لا يمكن مراسلة طلب بلا حساب مرتبط' }, { status: 403 })
    // Audience is a property of student-sent supervision messages only; everyone else defaults to ALL.
    const rawAudience = String(body.audience || 'ALL').toUpperCase()
    const audience = user.role === 'STUDENT' && (AUDIENCES as readonly string[]).includes(rawAudience) ? rawAudience : 'ALL'
    const msg = await db.supervisorChannelMessage.create({
      data: {
        admissionId,
        studentId: app.userId || user.id,
        supervisorId: app.supervisorId || null,
        senderId: user.id,
        senderRole: senderRole(user),
        scope,
        audience,
        mode,
        content: content || 'ملاحظة صوتية',
        audioData: audioData || null,
        audioMime: audioMime || null,
      },
    })
    if (user.role === 'STUDENT' && scope === 'SUPERVISION') {
      // Audience routing: HUMAN/ALL notify the human supervisor; AI does not.
      if (audience !== 'AI') {
        await notify(app.supervisorId || null, 'SUPERVISION', 'رسالة جديدة من طالب', `${app.fullName}: ${content || 'أرسل ملاحظة صوتية'}`, 'supervisor')
      }
      // Instant in-thread AI reply: audience AI/ALL only, text messages only (voice notes
      // carry no transcript to answer). Async via after() so the student's message is saved
      // and POST returns fast regardless of AI success; on failure nothing is posted and
      // the student message is untouched (safer than a confusing fallback notice).
      if ((audience === 'AI' || audience === 'ALL') && mode === 'TEXT' && content) {
        const studentId = app.userId || user.id
        const studentText = content
        const runAiReply = async () => {
          try {
            const reply = (await generateSupervisorThreadReply({ userId: studentId, content: studentText }) || '').trim()
            if (!reply) return
            await db.supervisorChannelMessage.create({
              data: {
                admissionId,
                studentId,
                supervisorId: app.supervisorId || null,
                senderId: null,
                senderRole: 'AI',
                scope: 'SUPERVISION',
                audience: 'ALL',
                mode: 'TEXT',
                content: reply,
              },
            })
          } catch (e) {
            console.error('supervision thread AI reply failed (student message kept):', e)
          }
        }
        try {
          after(() => runAiReply())
        } catch {
          // Outside a request scope (e.g. unit tests) after() is unavailable; fall back to
          // a fire-and-forget task with the same failure semantics.
          void runAiReply()
        }
      }
    } else if (user.role === 'STUDENT' && scope === 'ADMIN') {
      await notifyAdmins('ADMIN_MESSAGE', 'رد جديد من طالب برسائل الإدارة', `${app.fullName}: ${content || 'أرسل ملاحظة صوتية'}`, `admin-messages:${admissionId}`)
    } else if (user.role === 'ADMIN' && scope === 'ADMIN') {
      await notify(app.userId || null, 'ADMIN_MESSAGE', 'رسالة جديدة من الإدارة', content || 'أرسل مشرفك ملاحظة صوتية', `admin-messages:${admissionId}`)
    } else if (user.role === 'SUPERVISOR' && scope === 'SUPERVISION') {
      await notify(app.userId || null, 'SUPERVISION', 'رسالة من مشرفك الأكاديمي', content || 'أرسل مشرفك ملاحظة صوتية', 'dashboard')
    }
    return NextResponse.json({ ok: true, message: msg })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor messages POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر إرسال الرسالة' }, { status: 500 })
  }
}
