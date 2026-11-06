// محضر الاجتماع: يُبنى حصرًا من مدخلات حقيقية — جدول الأعمال كما
// كتبته الإدارة، وملاحظات المشاركين المكتوبة داخل صفحة الاجتماع،
// وسجل الحضور. لا يُبنى من جدول الأعمال وحده كمصدر وحيد للقرارات،
// ولا يخترع أسماء أو مواعيد أو مهام. المسودة تقترح صياغة فقط؛
// الاعتماد قرار بشري موثق (PENDING_REVIEW ← APPROVED)، والمحضر
// المعتمد مقفل لا يُعاد توليده.

export type MinutesSources = {
  agenda: string | null
  notes: { authorName: string; text: string }[]
  attendees: string[]
  invitees: string[]
}

export async function collectMinutesSources(db: any, meeting: any): Promise<MinutesSources> {
  const [notes, speechEvents, attendance, invites, users] = await Promise.all([
    db.adminMeetingNote.findMany({ where: { meetingId: meeting.id }, orderBy: { createdAt: 'asc' }, take: 200 }).catch(() => []),
    // Speech is collected only from access-checked, finalized participant segments.
    (db.adminMeetingAgentEvent?.findMany?.({ where: { meetingId: meeting.id, kind: { in: ['TRANSCRIPT', 'AI_SPEECH'] } }, orderBy: { createdAt: 'asc' }, take: 600 })?.catch(() => []) ?? []),
    db.adminMeetingAttendance.findMany({ where: { meetingId: meeting.id } }).catch(() => []),
    db.adminMeetingInvite.findMany({ where: { meetingId: meeting.id }, select: { inviteeName: true, claimedByUserId: true } }).catch(() => []),
    db.user.findMany({ where: {}, select: { id: true, name: true }, take: 0 }).catch(() => []),
  ])
  const userIds = [...new Set((attendance as any[]).map((a) => a.userId))]
  const named = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }).catch(() => [])
    : users
  const nameById = new Map((named as any[]).map((u) => [u.id, u.name]))
  // Keep written notes and participant-attributed audio transcripts in time order.
  // Recognition can be imperfect; the human must review before approving minutes.
  const combined = [
    ...(notes as any[]).map((n) => ({
      at: new Date(n.createdAt || 0).getTime(),
      authorName: n.authorName,
      text: n.text,
    })),
    ...(speechEvents as any[]).map((e) => ({
      at: new Date(e.createdAt || 0).getTime(),
      authorName: 'تفريغ صوتي آلي (يحتاج تدقيقًا)',
      text: e.text,
    })),
  ].sort((a, b) => a.at - b.at)
  return {
    agenda: meeting.agenda || null,
    notes: combined.map(({ authorName, text }) => ({ authorName, text })),
    attendees: (attendance as any[]).map((a) => `${nameById.get(a.userId) || 'مشارك'} — ${a.status === 'PRESENT' ? 'حاضر (مؤكد)' : a.status === 'ABSENT' ? 'غائب (مؤكد)' : 'دخل عبر المنصة'}`),
    invitees: (invites as any[]).map((i) => i.inviteeName),
  }
}

function mechanicalDraft(meeting: any, sources: MinutesSources) {
  return {
    summary: [
      `اجتماع «${meeting.title}» بتاريخ ${new Date(meeting.startsAt).toISOString()}.`,
      sources.attendees.length ? `الحضور المسجل: ${sources.attendees.join('؛ ')}.` : 'لا يوجد سجل حضور.',
      sources.notes.length
        ? `كتب المشاركون ${sources.notes.length} ملاحظة أثناء الاجتماع (تُرفق نصوصها في قسم النقاش عند المراجعة).`
        : 'لا توجد ملاحظات مكتوبة من المشاركين.',
    ].join('\n'),
    decisions: sources.notes.length ? '' : '',
    actionItems: '',
    deferred: '',
  }
}

export async function generateMinutesDraft(db: any, meeting: any, actorId: string) {
  const existing = await db.adminMeetingMinutes.findUnique({ where: { meetingId: meeting.id } }).catch(() => null)
  if (existing?.status === 'APPROVED') {
    return { ok: false as const, code: 'MINUTES_APPROVED_LOCKED', error: 'المحضر معتمد ومقفل — لا يُعاد توليده' }
  }
  const sources = await collectMinutesSources(db, meeting)
  let draft = mechanicalDraft(meeting, sources)
  let aiUsed = false
  if (sources.notes.length > 0) {
    try {
      const { textAiComplete } = await import('@/lib/text-ai')
      const raw = await textAiComplete({
        system:
          'أنت مُعدّ محاضر اجتماعات. من المدخلات التالية فقط (جدول الأعمال وملاحظات المشاركين المكتوبة والحضور) صِغ مسودة محضر بصيغة JSON حصرًا بالمفاتيح: summary (ملخص النقاش)، decisions (القرارات المؤكدة فقط كما وردت صراحة في الملاحظات؛ إن لم يرد قرار صريح أعد سلسلة فارغة)، actionItems (مهام بأصحابها ومواعيدها كما وردت فقط، وإلا فارغة)، deferred (نقاط مؤجلة كما وردت فقط، وإلا فارغة). ' +
          'ممنوع منعًا باتًا اختراع قرارات أو أسماء أو مواعيد أو مهام غير موجودة في المدخلات. ميّز بين المقترح والمقرر، ولا تنسب اقتراحًا كقرار.',
        history: [{
          role: 'user',
          text: [
            `عنوان الاجتماع: ${meeting.title}`,
            `جدول الأعمال:\n${sources.agenda || '—'}`,
            `المدعوون: ${sources.invitees.join('، ') || '—'}`,
            `الحضور المسجل:\n${sources.attendees.join('\n') || '—'}`,
            `ملاحظات المشاركين:\n${sources.notes.map((n) => `- ${n.authorName}: ${n.text}`).join('\n')}`,
          ].join('\n\n'),
        }],
        purpose: 'GENERATION',
        json: true,
        maxOutputTokens: 1600,
      })
      const parsed = JSON.parse(String(raw || '').trim())
      if (parsed && typeof parsed === 'object') {
        draft = {
          summary: String(parsed.summary || draft.summary),
          decisions: String(parsed.decisions || ''),
          actionItems: String(parsed.actionItems || ''),
          deferred: String(parsed.deferred || ''),
        }
        aiUsed = true
      }
    } catch {
      // بقاء المسودة الميكانيكية الصادقة — بلا أي اختراع
    }
  }
  const data = {
    title: `محضر اجتماع: ${meeting.title}`,
    summary: draft.summary || null,
    decisions: draft.decisions || null,
    actionItems: draft.actionItems || null,
    deferred: draft.deferred || null,
    generatedFrom: sources.notes.length ? (aiUsed ? 'AGENDA_AND_NOTES_AI_DRAFT' : 'AGENDA_AND_NOTES') : 'AGENDA_AND_ATTENDANCE',
    status: 'DRAFT',
    createdById: actorId,
    approvedById: null,
    approvedAt: null,
  }
  const minutes = existing
    ? await db.adminMeetingMinutes.update({ where: { meetingId: meeting.id }, data })
    : await db.adminMeetingMinutes.create({ data: { meetingId: meeting.id, ...data } })
  return { ok: true as const, minutes, sources }
}
