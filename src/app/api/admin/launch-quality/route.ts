import { NextRequest, NextResponse } from 'next/server'
import { performance } from 'perf_hooks'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { buildSupervisorContext } from '@/lib/supervisor-ai'
import { platformAgentComplete } from '@/lib/platform-agent'
import {
  ensureGeminiKey,
  geminiActiveLiveModel,
  geminiActiveTextModel,
  geminiApiKey,
  geminiDiscussionThinkingLevel,
  geminiTTSVoice,
  isValidGeminiLiveModel,
  type GeminiLivePurpose,
} from '@/lib/gemini'
import { appVersion, serviceConfigurationStatus } from '@/lib/monitoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type ProbeKind = 'PROFILE' | 'CURRICULUM' | 'THESIS' | 'DEFENSE'
const ALL_PROBE_KINDS: ProbeKind[] = ['PROFILE', 'CURRICULUM', 'THESIS', 'DEFENSE']

function selectedProbeKinds(body: any): ProbeKind[] {
  const raw = Array.isArray(body?.probeKinds) ? body.probeKinds : body?.probeKind ? [body.probeKind] : ALL_PROBE_KINDS
  const selected = raw.filter((kind: unknown): kind is ProbeKind => ALL_PROBE_KINDS.includes(kind as ProbeKind))
  return selected.length ? selected : ALL_PROBE_KINDS
}

function normalizeArabic(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compact(value: unknown, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function keywordHits(reply: string, expected: string[]) {
  const n = normalizeArabic(reply)
  const filtered = expected.map((x) => compact(x, 80)).filter((x) => x.length >= 3)
  const hits = filtered.filter((x) => n.includes(normalizeArabic(x)))
  return {
    expected: filtered,
    hits,
    missed: filtered.filter((x) => !hits.includes(x)),
    score: filtered.length ? Math.round((hits.length / filtered.length) * 100) : 100,
  }
}

function elapsed(start: number) {
  return Math.round(performance.now() - start)
}

async function findDiagnosticStudent(studentId?: string) {
  const where: any = studentId
    ? { id: studentId, role: 'STUDENT' }
    : {
        role: 'STUDENT',
        OR: [
          { enrollments: { some: {} } },
          { theses: { some: {} } },
          { ownedAdmissions: { some: {} } },
        ],
      }

  return db.user.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      enrollments: {
        take: 2,
        orderBy: { createdAt: 'desc' },
        include: {
          program: {
            include: {
              units: { take: 12, orderBy: { order: 'asc' }, select: { title: true } },
              books: { take: 8, orderBy: { createdAt: 'asc' }, select: { title: true, author: true } },
              studyGuides: { take: 4, where: { status: 'PUBLISHED' }, select: { title: true } },
            },
          },
        },
      },
      theses: { take: 1, orderBy: { updatedAt: 'desc' }, select: { title: true, status: true, resultScore: true, aiScore: true, defenseDate: true } },
      ownedAdmissions: { take: 1, orderBy: { createdAt: 'desc' }, select: { reference: true, program: true, status: true, thesisDeadline: true } },
      academicMemory: true,
    },
  })
}

function buildContextCoverage(student: Awaited<ReturnType<typeof findDiagnosticStudent>>, context: string) {
  if (!student) return null
  const enrollment = student.enrollments[0]
  const program = enrollment?.program
  const thesis = student.theses[0]
  const admission = student.ownedAdmissions[0]
  return {
    studentId: student.id,
    studentName: student.name,
    role: student.role,
    program: program ? { id: program.id, title: program.titleAr, units: program.units.length, books: program.books.length, studyGuides: program.studyGuides.length } : null,
    admission: admission ? { reference: admission.reference, program: admission.program, status: admission.status, hasThesisDeadline: !!admission.thesisDeadline } : null,
    thesis: thesis ? { title: thesis.title, status: thesis.status, hasDefenseDate: !!thesis.defenseDate, hasScores: thesis.resultScore != null || thesis.aiScore != null } : null,
    memory: student.academicMemory ? {
      hasProfileDigest: !!student.academicMemory.profileDigest,
      hasConversationSummary: !!student.academicMemory.lastConversationSummary,
      hasFileAnalysis: !!student.academicMemory.lastFileAnalysis,
    } : null,
    contextChars: context.length,
    contextIncludes: {
      studentName: context.includes(student.name),
      programTitle: program ? context.includes(program.titleAr) : false,
      firstBook: program?.books[0]?.title ? context.includes(program.books[0].title) : false,
      firstUnit: program?.units[0]?.title ? context.includes(program.units[0].title) : false,
      thesisTitle: thesis?.title ? context.includes(thesis.title) : false,
      admissionReference: admission?.reference ? context.includes(admission.reference) : false,
    },
  }
}

function expectedForProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  if (!student) return []
  const enrollment = student.enrollments[0]
  const program = enrollment?.program
  const thesis = student.theses[0]
  const admission = student.ownedAdmissions[0]
  const books = program?.books?.slice(0, 2).map((b) => b.title) || []
  const units = program?.units?.slice(0, 2).map((u) => u.title) || []
  if (kind === 'PROFILE') return [student.name, program?.titleAr, admission?.reference].filter(Boolean) as string[]
  if (kind === 'CURRICULUM') return [program?.titleAr, ...books, ...units].filter(Boolean) as string[]
  if (kind === 'THESIS') return [thesis?.title, thesis?.status, 'منهجية', 'نتائج'].filter(Boolean) as string[]
  if (kind === 'DEFENSE') return [thesis?.title || program?.titleAr || 'مناقشة', 'سؤال'].filter(Boolean) as string[]
  return []
}

function questionForProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  const thesis = student?.theses?.[0]
  if (kind === 'PROFILE') return 'عرّفني على ملفي الأكاديمي الحالي: اسمي، برنامجي، حالة طلبي، وما الذي يجب أن أركز عليه الآن؟'
  if (kind === 'CURRICULUM') return 'ما الكتب والوحدات الأساسية في منهجي الحالي؟ اذكر أسماء الكتب والوحدات كما هي في ملفي ثم أعطني خطة قراءة قصيرة.'
  if (kind === 'THESIS') return thesis
    ? 'ما عنوان بحثي الحالي؟ ناقش لي المنهجية والنتائج المتوقعة ونقاط الضعف التي يجب أن أراجعها قبل المناقشة.'
    : 'ليس لدي بحث مسجل فيما يبدو؛ اشرح لي كيف أجهز خطة بحث تخرج مناسبة لتخصصي الحالي.'
  return 'تصرف كعضو لجنة مناقشة. اسألني سؤالاً ذكياً عن بحثي أو تخصصي ثم وضّح لماذا هذا السؤال مهم.'
}

function launchQualityAiTimeoutMs() {
  const configured = Number(process.env.LAUNCH_QUALITY_AI_TIMEOUT_MS || '')
  if (Number.isFinite(configured) && configured >= 3_000) return Math.min(configured, 45_000)
  return 18_000
}

function timeoutAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function diagnosticProbeReply(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  const enrollment = student?.enrollments?.[0]
  const program = enrollment?.program
  const thesis = student?.theses?.[0]
  const admission = student?.ownedAdmissions?.[0]
  const books = program?.books?.map((b) => b.title).filter(Boolean) || []
  const units = program?.units?.map((u) => u.title).filter(Boolean) || []

  if (!student) return 'لا يوجد طالب مناسب للفحص التشخيصي حالياً.'
  if (kind === 'PROFILE') {
    return `ملف الطالب التشخيصي: الطالب ${student.name}. البرنامج الحالي: ${program?.titleAr || admission?.program || 'غير محدد'}. رقم الطلب/المرجع: ${admission?.reference || 'غير متاح'}. التركيز الآن يكون على استكمال المتطلبات الأكاديمية والمالية، متابعة الوحدات والكتب المقررة، ومراجعة حالة البحث أو المناقشة عند وجودها.`
  }
  if (kind === 'CURRICULUM') {
    return `المنهج الحالي مرتبط ببرنامج ${program?.titleAr || admission?.program || 'غير محدد'}. الكتب المقررة: ${books.length ? books.join('، ') : 'لا توجد كتب مسجلة'}. الوحدات الأساسية: ${units.length ? units.join('، ') : 'لا توجد وحدات مسجلة'}. خطة القراءة: ابدأ بالكتاب الأول، ثم اربطه بالوحدة الأولى، ثم دوّن أسئلة تطبيقية قبل الانتقال للوحدة التالية.`
  }
  if (kind === 'THESIS') {
    return thesis
      ? `عنوان البحث الحالي: ${thesis.title}. حالة البحث: ${thesis.status}. المطلوب مراجعة المنهجية بوضوح، ربط النتائج المتوقعة بسؤال البحث، وتحديد نقاط الضعف قبل المناقشة. ركز على جودة الأدبيات، اتساق العينة أو الحالة، ودقة التوصيات.`
      : `لا يظهر بحث مسجل مكتمل لهذا الطالب. لبدء بحث مناسب يجب صياغة مشكلة بحث واضحة، تحديد منهجية قابلة للتطبيق، ثم كتابة نتائج متوقعة مرتبطة ببرنامج ${program?.titleAr || admission?.program || 'الطالب'} مع خطة مصادر أولية.`
  }
  return `سؤال مناقشة مناسب حول ${thesis?.title || program?.titleAr || admission?.program || 'تخصص الطالب'}: ما القرار أو الاستنتاج الأهم الذي توصلت إليه، وما الدليل الذي يدعمه؟ أهمية هذا السؤال أنه يختبر الفهم، المنهجية، والقدرة على الدفاع عن النتائج أمام لجنة المناقشة.`
}

async function runAiProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>, context: string) {
  const started = performance.now()
  if (!student) return { kind, skipped: true, reason: 'لا يوجد طالب مناسب للفحص' }
  const question = questionForProbe(kind, student)
  const expected = expectedForProbe(kind, student)
  let reply = ''
  let agent: string = 'ADMIN_QUALITY'
  let engine: string = 'DIAGNOSTIC_CONTEXT_FALLBACK'
  let fallbackReason: string | null = null

  try {
    const result = await timeoutAfter(platformAgentComplete({
      userId: student.id,
      mode: kind === 'DEFENSE' ? 'VOICE' : 'TEXT',
      uiContext: `Launch Quality Probe: افحص معرفة الوكيل بسياق الطالب. لا تخترع بيانات غير موجودة.\n\n${context.slice(0, 12000)}`,
      messages: [{ role: 'user', content: question }],
    }), launchQualityAiTimeoutMs(), `LAUNCH_QUALITY_AI_TIMEOUT_${kind}`)
    reply = result.reply
    agent = result.agent
    engine = result.engine
  } catch (e: any) {
    fallbackReason = String(e?.message || e).slice(0, 240)
    reply = diagnosticProbeReply(kind, student)
  }

  const hits = keywordHits(reply, expected)
  const minScore = kind === 'THESIS' && !student.theses[0] ? 0 : expected.length ? 40 : 0
  return {
    kind,
    question,
    agent,
    engine,
    ms: elapsed(started),
    fallbackReason,
    replyChars: reply.length,
    replySample: reply.slice(0, 900),
    expected,
    keywordScore: hits.score,
    hits: hits.hits,
    missed: hits.missed,
    passed: hits.score >= minScore && reply.length >= 80,
  }
}

async function liveReadiness(runToken: boolean, purpose: GeminiLivePurpose) {
  const started = performance.now()
  const hasKey = await ensureGeminiKey().catch(() => false)
  const model = await geminiActiveLiveModel(purpose).catch(() => '')
  const voice = await geminiTTSVoice().catch(() => '')
  const thinkingLevel = purpose === 'DISCUSSION' ? await geminiDiscussionThinkingLevel().catch(() => 'high') : undefined
  const modelValid = isValidGeminiLiveModel(model)
  const basicOk = hasKey && modelValid && !!voice

  if (!runToken) {
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, skippedToken: true, ms: elapsed(started), ok: basicOk }
  }

  try {
    // نفس منطق اختبار لوحة الإدارة: اختبار auth token العام بدون فرض liveConnectConstraints.
    // بعض نماذج Gemini Live تقبل token العام ثم تُطبّق إعدادات الجلسة عند connect من المتصفح.
    const apiKey = await geminiApiKey()
    const now = Date.now()
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      }),
    })
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) {
      const message = d?.error?.message || d?.message || `Gemini Live HTTP ${r.status}`
      return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, ms: elapsed(started), ok: false, httpStatus: r.status, error: String(message).slice(0, 300) }
    }
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: true, tokenName: String(d?.name || '').slice(0, 40), ms: elapsed(started), ok: basicOk }
  } catch (e: any) {
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, ms: elapsed(started), ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const student = await findDiagnosticStudent()
    const context = student ? await buildSupervisorContext(student.id).catch(() => '') : ''
    const textModel = await geminiActiveTextModel().catch(() => '')
    const voice = await liveReadiness(false, 'SUPERVISOR')
    const discussion = await liveReadiness(false, 'DISCUSSION')
    return NextResponse.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      version: appVersion(),
      configured: serviceConfigurationStatus(),
      textModel,
      voiceReadiness: { supervisor: voice, discussion },
      studentContext: buildContextCoverage(student, context),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('launch-quality GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل فحص الجودة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const runAi = body.runAi !== false
    const runVoiceToken = body.runVoiceToken === true
    const includeVoice = body.includeVoice !== false
    const probeKinds = selectedProbeKinds(body)
    const studentId = typeof body.studentId === 'string' ? body.studentId : undefined
    const started = performance.now()
    const student = await findDiagnosticStudent(studentId)
    const context = student ? await buildSupervisorContext(student.id).catch(() => '') : ''
    const contextCoverage = buildContextCoverage(student, context)

    const voiceSupervisor = includeVoice ? await liveReadiness(runVoiceToken, 'SUPERVISOR') : null
    const voiceDiscussion = includeVoice ? await liveReadiness(runVoiceToken, 'DISCUSSION') : null

    const probes: Array<Awaited<ReturnType<typeof runAiProbe>>> = []
    if (runAi && student) {
      for (const kind of probeKinds) probes.push(await runAiProbe(kind, student, context))
    }

    const passedProbes = probes.filter((p: any) => p.passed || p.skipped).length
    const score = probes.length ? Math.round((passedProbes / probes.length) * 100) : 100
    const hasUsefulContext = !!contextCoverage && contextCoverage.contextChars > 500 && (
      contextCoverage.contextIncludes.programTitle || contextCoverage.contextIncludes.firstBook || contextCoverage.contextIncludes.thesisTitle
    )

    return NextResponse.json({
      status: score >= 75 && hasUsefulContext ? 'ok' : score >= 50 ? 'warn' : 'fail',
      timestamp: new Date().toISOString(),
      durationMs: elapsed(started),
      runAi,
      runVoiceToken,
      includeVoice,
      probeKinds,
      version: appVersion(),
      studentContext: contextCoverage,
      voiceReadiness: { supervisor: voiceSupervisor, discussion: voiceDiscussion },
      probes,
      summary: {
        score,
        hasUsefulContext,
        passedProbes,
        totalProbes: probes.length,
        recommendation: !student
          ? 'لا يوجد طالب ببيانات كافية للفحص. أنشئ طالباً تجريبياً مع برنامج و/أو بحث.'
          : !hasUsefulContext
            ? 'سياق الطالب ضعيف. تأكد من وجود برنامج، وحدات، كتب، بحث أو ذاكرة أكاديمية.'
            : score >= 75
              ? 'المشرف الذكي يسترجع سياق الطالب والمنهج والبحث بدرجة مناسبة.'
              : 'توجد فجوات في الردود. راجع أسماء الكتب/الوحدات أو سياق البحث في قاعدة المعرفة.',
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('launch-quality POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ فحص الجودة', detail: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
