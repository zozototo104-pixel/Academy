import {
  claimMeetingInvite,
  deriveMeetingStatus,
  isMeetingJoinOpen,
  meetingAccessFor,
  meetingInviteProblem,
  meetingJoinOpensAt,
} from '@/lib/admin-meetings'
import { checkDatabaseRateLimit } from '@/lib/rate-limit'
import { createHmac } from 'node:crypto'
import { addMeetingNote, addMeetingTranscript, askMeetingAssistant, collectMeetingAcademyEvidence, createMeetingLiveVoiceSession } from '@/lib/meeting-assistant'

// منطق دخول الاجتماع المشترك بين مسارَي الدخول: رابط الدعوة
// (/api/meetings/[token]) والدخول بالحساب بعد الاستلام
// (/api/meetings/claimed/[inviteId]). القواعد واحدة: الدعوة الصالحة
// + الاستلام بالحساب شرطٌ للتفاصيل، وكشف الرابط/الغرفة محكوم
// بنافذة الـ15 دقيقة من الخادم حصرًا.

type Json = { status: number; body: Record<string, unknown> }

function teaserOf(meeting: any) {
  return {
    title: meeting.title,
    startsAt: meeting.startsAt,
    endsAt: meeting.endsAt,
    timezone: meeting.timezone,
    hostName: meeting.hostName,
  }
}

export async function meetingState(db: any, invite: any, user: { id: string; role?: string; name?: string } | null): Promise<Json> {
  const problem = meetingInviteProblem(invite)
  if (problem) return { status: 200, body: { ok: true, level: 'NONE', problem } }
  const meeting = invite.meeting
  const access = await meetingAccessFor(db, invite, user)
  const base = {
    effectiveStatus: deriveMeetingStatus(meeting),
    joinOpen: isMeetingJoinOpen(meeting),
    joinOpensAt: meetingJoinOpensAt(meeting).toISOString(),
  }
  if (!user) {
    // اسم المدعو نفسه يُعرض لحامل الرابط (الرابط هو الاعتماد) حتى
    // يُملأ نموذج إنشاء حساب الزائر في صفحة الدعوة باسمه مسبقًا.
    return {
      status: 200,
      body: { ok: true, level: 'TEASER', loginRequired: true, meeting: teaserOf(meeting), myInvite: { inviteeName: invite.inviteeName }, ...base },
    }
  }
  if (access.level === 'NONE') return { status: 200, body: { ok: true, level: 'NONE', problem: 'CLAIMED_BY_OTHER' } }
  // فتح الدعوة من صاحبها المحتمل/المستلم يُسجَّل (مقيّدًا زمنيًا)
  if (!invite.lastOpenedAt || Date.now() - new Date(invite.lastOpenedAt).getTime() > 5 * 60_000) {
    await db.adminMeetingInvite.update({ where: { id: invite.id }, data: { lastOpenedAt: new Date() } }).catch(() => {})
  }
  // تفاصيل الاجتماع الكاملة (الوصف والأجندة وأسماء المدعوين) لا تُكشف
  // إلا بعد استلام الدعوة (FULL) — حامل دعوة لم يستلمها بعد (CLAIMABLE)
  // يرى التمهيد العام فقط، كما تنصّ سياسة meetingAccessFor.
  const invites = access.level === 'FULL'
    ? await db.adminMeetingInvite.findMany({
        where: { meetingId: meeting.id },
        select: { inviteeName: true },
        orderBy: { createdAt: 'asc' },
      }).catch(() => [])
    : []
  const attendance = access.level === 'FULL'
    ? await db.adminMeetingAttendance.findUnique({
        where: { meetingId_userId: { meetingId: meeting.id, userId: user.id } },
        select: { status: true, joinedAt: true },
      }).catch(() => null)
    : null
  const notes = access.level === 'FULL'
    ? await (db.adminMeetingNote?.findMany({
        where: { meetingId: meeting.id },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { id: true, authorName: true, text: true, createdAt: true },
      })?.catch(() => []) ?? [])
    : []
  return {
    status: 200,
    body: {
      ok: true,
      level: access.level,
      meeting: access.level === 'FULL'
        ? {
            ...teaserOf(meeting),
            description: meeting.description,
            agenda: meeting.agenda,
            provider: meeting.provider,
            aiAssistantEnabled: meeting.aiAssistantEnabled,
            minutesEnabled: meeting.minutesEnabled,
            status: meeting.status,
            inviteeNames: (invites as any[]).map((i) => i.inviteeName),
          }
        : teaserOf(meeting),
      myInvite: { inviteeName: invite.inviteeName },
      attendance,
      notes,
      ...base,
    },
  }
}

export async function meetingAction(
  db: any,
  invite: any,
  user: { id: string; role?: string; name?: string } | null,
  action: string,
  payload?: { question?: string; text?: string; userText?: string; aiText?: string },
): Promise<Json> {
  const problem = meetingInviteProblem(invite)
  if (problem) return { status: 410, body: { error: 'رابط الدعوة غير صالح', code: problem } }
  if (!user) return { status: 401, body: { error: 'سجّل الدخول أولًا', code: 'LOGIN_REQUIRED' } }
  const meeting = invite.meeting
  const access = await meetingAccessFor(db, invite, user)

  if (action === 'claim') {
    if (access.level === 'NONE') return { status: 403, body: { error: 'هذه الدعوة مستلَمة من حساب آخر', code: 'CLAIMED_BY_OTHER' } }
    if (access.level === 'FULL') return { status: 200, body: { ok: true, alreadyClaimed: true } }
    const claimed = await claimMeetingInvite(db, invite, user.id)
    if (!claimed.ok) return { status: 403, body: { error: 'هذه الدعوة مستلَمة من حساب آخر', code: claimed.code } }
    return { status: 200, body: { ok: true } }
  }

  if (action === 'join') {
    if (access.level !== 'FULL') return { status: 403, body: { error: 'استلم الدعوة بحسابك أولًا', code: 'NOT_CLAIMED' } }
    if (meeting.status === 'CANCELLED') return { status: 409, body: { error: 'الاجتماع ملغى', code: 'MEETING_CANCELLED' } }
    if (!isMeetingJoinOpen(meeting)) {
      return {
        status: 403,
        body: { error: 'لم يفتح الدخول بعد — يفتح قبل الموعد بـ15 دقيقة', code: 'JOIN_WINDOW_CLOSED', joinOpensAt: meetingJoinOpensAt(meeting).toISOString() },
      }
    }
    const limit = await checkDatabaseRateLimit(`meetings:join:${meeting.id}:${user.id}`, 10, 10 * 60_000).catch(() => null)
    if (limit && !limit.ok) return { status: 429, body: { error: 'محاولات كثيرة — انتظر قليلًا', code: 'RATE_LIMITED' } }
    // JOINED = ضغط زر الدخول داخل النافذة (لا يدّعي حضورًا مؤكدًا)
    await db.adminMeetingAttendance.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId: user.id } },
      create: { meetingId: meeting.id, userId: user.id, inviteId: invite.id, status: 'JOINED' },
      update: {},
    }).catch(() => {})
    if (meeting.provider === 'PLATFORM') return { status: 200, body: { ok: true, room: true } }
    if (!meeting.meetingUrl) return { status: 409, body: { error: 'لم يُضف رابط الاجتماع بعد', code: 'NO_MEETING_URL' } }
    const result: Record<string, unknown> = { ok: true, meetingUrl: meeting.meetingUrl, meetingPasscode: meeting.meetingPasscode }
    if (meeting.provider === 'ZOOM') {
      const match = String(meeting.meetingUrl).match(/^https:\/\/[a-z0-9.-]*zoom\.us\/j\/(\d{9,11})(?:[/?#]|$)/i)
      const sdkKey = process.env.ZOOM_MEETING_SDK_CLIENT_ID
      const sdkSecret = process.env.ZOOM_MEETING_SDK_CLIENT_SECRET
      if (match && sdkKey && sdkSecret) {
        const now = Math.floor(Date.now() / 1000)
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const unsigned = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({
          sdkKey, appKey: sdkKey, mn: match[1], role: 0, iat: now - 30, exp: now + 60 * 60, tokenExp: now + 60 * 60,
        })
        const signature = createHmac('sha256', sdkSecret).update(unsigned).digest('base64url')
        result.zoomSdk = {
          signature: unsigned + '.' + signature,
          sdkKey,
          meetingNumber: match[1],
          userName: String(user.name || invite.inviteeName || 'Guest').slice(0, 100),
          password: meeting.meetingPasscode || '',
        }
      }
    }
    return { status: 200, body: result }
  }

  // The bot runs under a dedicated, authenticated ADMIN account and is
  // physically connected as a participant on a separate device. No meeting
  // invite or guest account can obtain voice tokens or privileged DB tools.
  if (action === 'voice-session' || action === 'live-data' || action === 'live-turn') {
    if (access.level !== 'FULL' || user.role !== 'ADMIN') {
      return { status: 403, body: { error: 'تشغيل المشارك الذكي والبيانات الإدارية يتطلب حساب إدارة مخوّلاً', code: 'MEETING_AGENT_ADMIN_REQUIRED' } }
    }
    if (!meeting.aiAssistantEnabled || !['ZOOM', 'PLATFORM'].includes(meeting.provider)) {
      return { status: 403, body: { error: 'المشارك الصوتي غير مفعّل لهذا النوع من الاجتماعات', code: 'MEETING_AGENT_DISABLED' } }
    }
    if (!isMeetingJoinOpen(meeting)) {
      return { status: 403, body: { error: 'الجلسة الصوتية متاحة أثناء الاجتماع فقط', code: 'NOT_LIVE' } }
    }
    const max = action === 'voice-session' ? 6 : action === 'live-data' ? 120 : 80
    const guard = await checkDatabaseRateLimit(
      'meetings:ai-live:' + action + ':' + meeting.id + ':' + user.id, max, 10 * 60_000,
    ).catch(() => null)
    if (!guard) return { status: 503, body: { error: 'تعذر التحقق من قيود الاستخدام', code: 'RATE_GUARD_UNAVAILABLE' } }
    if (!guard.ok) return { status: 429, body: { error: 'تجاوزت الحد المسموح لاستخدام المشرف الصوتي', code: 'RATE_LIMITED' } }

    if (action === 'voice-session') {
      try { return await createMeetingLiveVoiceSession(meeting, user) }
      catch (error) {
        console.error('meeting live session failure:', String((error as Error)?.message || error).slice(0, 200))
        return { status: 502, body: { error: 'تعذر بدء جلسة Gemini Live لهذا الاجتماع', code: 'MEETING_LIVE_UNAVAILABLE' } }
      }
    }
    if (action === 'live-data') {
      const query = String(payload?.question || '').trim().slice(0, 300)
      if (!query) return { status: 400, body: { error: 'سؤال الاستعلام مطلوب', code: 'EMPTY_QUERY' } }
      try {
        return { status: 200, body: { ok: true, snippets: await collectMeetingAcademyEvidence(db, query, user) } }
      } catch {
        return { status: 503, body: { error: 'بيانات الأكاديمية غير متاحة الآن. لا تقدم أرقاماً غير متحقق منها.', code: 'MEETING_DATA_UNAVAILABLE' } }
      }
    }
    const studentSpeech = String(payload?.userText || '').replace(/\s+/g, ' ').trim().slice(0, 2200)
    const agentSpeech = String(payload?.aiText || '').replace(/\s+/g, ' ').trim().slice(0, 2200)
    if (!studentSpeech && !agentSpeech) return { status: 400, body: { error: 'لا توجد مداخلة مسموعة للحفظ', code: 'EMPTY_LIVE_TURN' } }
    if (!meeting.minutesEnabled) return { status: 200, body: { ok: true, recorded: false } }
    try {
      await db.adminMeetingAgentEvent.createMany({ data: [
        ...(studentSpeech ? [{ meetingId: meeting.id, userId: user.id, kind: 'TRANSCRIPT',
          text: 'صوت الاجتماع — المتحدث غير محدد: ' + studentSpeech }] : []),
        ...(agentSpeech ? [{ meetingId: meeting.id, userId: user.id, kind: 'AI_SPEECH',
          text: 'المشرف الذكي — مداخلة صوتية: ' + agentSpeech }] : []),
      ] })
      return { status: 200, body: { ok: true, recorded: true } }
    } catch {
      return { status: 503, body: { error: 'تعذر حفظ تفريغ المداخلة', code: 'TRANSCRIPT_SAVE_FAILED' } }
    }
  }

  if (action === 'note') {
    const res = await addMeetingNote(db, invite, user, String(payload?.text || ''))
    return { status: res.status, body: res.body }
  }

  if (action === 'transcript') {
    const res = await addMeetingTranscript(db, invite, user, String(payload?.text || ''))
    return { status: res.status, body: res.body }
  }

  if (action === 'ask') {
    const res = await askMeetingAssistant(db, invite, user, String(payload?.question || ''))
    return { status: res.status, body: res.body }
  }

  return { status: 400, body: { error: 'إجراء غير معروف', code: 'UNKNOWN_ACTION' } }
}
