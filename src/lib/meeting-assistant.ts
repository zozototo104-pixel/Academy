import { isMeetingJoinOpen, meetingAccessFor, meetingJoinOpensAt } from '@/lib/admin-meetings'
import { checkDatabaseRateLimit } from '@/lib/rate-limit'

// مساعد الاجتماع الذكي — وضع نصي بمسار المنصة الحالي. لا يسمع صوت
// Zoom/Meet (لا وصول تقني له)، ومعرفته محصورة بسياق هذا الاجتماع:
// العنوان وجدول الأعمال وأسماء المدعوين وملاحظات المشاركين المكتوبة.
// لا يُستدعى إلا بطلب صريح من مشارك (زر «اسأل المساعد»)، وترحيبه
// يُسجَّل كحدث مرة واحدة لكل اجتماع فلا يتكرر مع التحديث.

export const MEETING_GREETING = (title: string) =>
  `أهلًا بالجميع في اجتماع «${title}». أنا المشرف الذكي، حاضر معكم لمتابعة النقاش وتوضيح المعلومات المهمة وتقديم الملاحظات عند الحاجة.`

export async function askMeetingAssistant(
  db: any,
  invite: any,
  user: { id: string; role?: string; name?: string },
  question: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const meeting = invite.meeting
  const access = await meetingAccessFor(db, invite, user)
  if (access.level !== 'FULL') return { status: 403, body: { error: 'استلم الدعوة بحسابك أولًا', code: 'NOT_CLAIMED' } }
  if (!meeting.aiAssistantEnabled) return { status: 403, body: { error: 'مساعد الاجتماع غير مفعّل لهذا الاجتماع', code: 'ASSISTANT_DISABLED' } }
  if (meeting.status === 'CANCELLED') return { status: 409, body: { error: 'الاجتماع ملغى', code: 'MEETING_CANCELLED' } }
  if (!isMeetingJoinOpen(meeting)) return { status: 403, body: { error: 'المساعد يعمل أثناء الاجتماع فقط', code: 'NOT_LIVE' } }
  const clean = String(question || '').trim().slice(0, 1000)
  if (!clean) return { status: 400, body: { error: 'اكتب سؤالك أولًا', code: 'EMPTY_QUESTION' } }
  const limit = await checkDatabaseRateLimit(`meetings:assistant:${meeting.id}:${user.id}`, 20, 10 * 60_000).catch(() => null)
  if (limit && !limit.ok) return { status: 429, body: { error: 'أسئلة كثيرة — انتظر قليلًا', code: 'RATE_LIMITED' } }

  // الترحيب مرة واحدة لكل اجتماع (حدث مسجّل، لا يعاد مع التحديث)
  let greeting: string | null = null
  const priorGreetings = await db.adminMeetingAgentEvent.count({ where: { meetingId: meeting.id, kind: 'GREETING' } }).catch(() => 1)
  if (priorGreetings === 0) {
    greeting = MEETING_GREETING(meeting.title)
    await db.adminMeetingAgentEvent.create({ data: { meetingId: meeting.id, kind: 'GREETING', text: greeting } }).catch(() => {})
  }

  const [notes, attendance, invites] = await Promise.all([
    db.adminMeetingNote.findMany({ where: { meetingId: meeting.id }, orderBy: { createdAt: 'asc' }, take: 40 }).catch(() => []),
    db.adminMeetingAttendance.findMany({ where: { meetingId: meeting.id }, select: { userId: true, status: true } }).catch(() => []),
    db.adminMeetingInvite.findMany({ where: { meetingId: meeting.id }, select: { inviteeName: true } }).catch(() => []),
  ])
  const context = [
    `عنوان الاجتماع: ${meeting.title}`,
    meeting.hostName ? `المنظّم: ${meeting.hostName}` : '',
    `المدعوون: ${(invites as any[]).map((i) => i.inviteeName).join('، ') || '—'}`,
    `جدول الأعمال:\n${meeting.agenda || '—'}`,
    notes.length
      ? `ملاحظات المشاركين أثناء الاجتماع:\n${(notes as any[]).map((n) => `- ${n.authorName}: ${n.text}`).join('\n')}`
      : 'ملاحظات المشاركين: لا شيء مكتوب بعد.',
  ].filter(Boolean).join('\n\n')

  let answer: string
  try {
    const { textAiComplete } = await import('@/lib/text-ai')
    answer = await textAiComplete({
      system:
        'أنت مساعد اجتماع داخل منصة أكاديمية. أجب بالعربية وباختصار ودقة من سياق الاجتماع التالي فقط. ' +
        'لا تخترع قرارات أو أقوالًا أو أسماء أو مواعيد غير موجودة في السياق؛ إن غابت المعلومة قل بوضوح: لا أعرف من جدول الأعمال والملاحظات المتاحة. ' +
        'لا تنسب قولًا لشخص إلا إن ورد في الملاحظات باسمه.\n\n' + context,
      history: [{ role: 'user', text: clean }],
      purpose: 'CHAT',
      maxOutputTokens: 700,
    })
    answer = String(answer || '').trim()
    if (!answer) throw new Error('EMPTY')
  } catch {
    return { status: 503, body: { error: 'المساعد غير متاح الآن — حاول بعد قليل', code: 'ASSISTANT_UNAVAILABLE', greeting } }
  }

  await db.adminMeetingAgentEvent.create({ data: { meetingId: meeting.id, userId: user.id, kind: 'QUESTION', text: clean } }).catch(() => {})
  await db.adminMeetingAgentEvent.create({ data: { meetingId: meeting.id, userId: user.id, kind: 'ANSWER', text: answer } }).catch(() => {})
  return { status: 200, body: { ok: true, answer, greeting } }
}

export async function addMeetingNote(
  db: any,
  invite: any,
  user: { id: string; role?: string; name?: string },
  text: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const meeting = invite.meeting
  const access = await meetingAccessFor(db, invite, user)
  if (access.level !== 'FULL') return { status: 403, body: { error: 'استلم الدعوة بحسابك أولًا', code: 'NOT_CLAIMED' } }
  if (meeting.status === 'CANCELLED') return { status: 409, body: { error: 'الاجتماع ملغى', code: 'MEETING_CANCELLED' } }
  // الملاحظات تُكتب أثناء الاجتماع فقط: نفس نافذة الدخول المفروضة
  // خادميًا على الانضمام والمساعد (تفتح قبل الموعد بـ15 دقيقة
  // وتُغلق عند انتهاء الاجتماع). القراءة في meetingState غير
  // محكومة بالنافذة — الحظر على الحفظ فقط.
  if (!isMeetingJoinOpen(meeting)) {
    return {
      status: 403,
      body: {
        error: 'الملاحظات تُحفظ أثناء الاجتماع فقط — يفتح قبل الموعد بـ15 دقيقة ويُغلق عند انتهائه',
        code: 'JOIN_WINDOW_CLOSED',
        joinOpensAt: meetingJoinOpensAt(meeting).toISOString(),
      },
    }
  }
  const clean = String(text || '').trim().slice(0, 4000)
  if (!clean) return { status: 400, body: { error: 'الملاحظة فارغة', code: 'EMPTY_NOTE' } }
  const note = await db.adminMeetingNote.create({
    data: { meetingId: meeting.id, userId: user.id, authorName: user.name || invite.inviteeName || 'مشارك', text: clean },
  })
  return { status: 200, body: { ok: true, note: { id: note.id, authorName: note.authorName, text: note.text, createdAt: note.createdAt } } }
}
