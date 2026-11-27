import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { decryptSecret, isEncryptedSecret } from '@/lib/secret-crypto'
import { searchTavily, TavilySearchError } from '@/lib/tavily-search'
import { normalizeArabic } from '@/lib/arabic-normalize'
import { COMPREHENSIVE_EXAM_QUESTION_COUNT, internetAcademicTopicIssue } from '@/lib/comprehensive-exam'
import {
  INTERNET_MAX_SEARCH_RESULTS,
  buildSpecialtyInternetQuery,
  buildSpecialtyResearchQueries,
  clampInternetQuestionCount,
  diverseInternetEvidence,
  generateInternetQuestions,
  internetSourceId,
  suggestComprehensiveInternetPlan,
} from '@/lib/comprehensive-exam-internet'

export const runtime = 'nodejs'
export const maxDuration = 300

// The Tavily key lives in the Setting table (encrypted at rest, like
// every provider key) and is read server-side only — never exposed to
// the browser. process.env.TAVILY_API_KEY is the fallback for
// deployments that prefer env vars. Never logged, never returned.
export async function readTavilyApiKey(): Promise<string | null> {
  const row = await (db as any).setting?.findUnique?.({ where: { key: 'TAVILY_API_KEY' } })
  const raw = String(row?.value || '').trim()
  if (raw) {
    try {
      if (isEncryptedSecret(raw)) return decryptSecret(raw)
    } catch {
      // The stored value is not decryptable — treat it as-is rather
      // than failing the whole request on a settings read.
    }
    return raw
  }
  return process.env.TAVILY_API_KEY?.trim() || null
}

// POST /api/admin/comprehensive-exams/[id]/questions/from-internet
// بحث الذكاء عبر الإنترنت (Tavily): يبحث في الويب عن الموضوع، ثم
// يولّد أسئلة من الخلاصات الراجعة فقط — كل سؤال بدليل حرفي من خلاصة
// ورابط مصدرها، وكلها بانتظار المراجعة. لا تُخترع أسئلة أبداً: بلا
// مفتاح → 422 صريح، بلا نتائج → 422 صريح، فشل البحث → 502 صريح،
// دفعة فارغة كلياً → فشل صريح. الدفعات الجزئية تحفظ الناجي وتبلّغ
// عن النقص.
async function handleInternetPost(req: NextRequest, ctx: { params: Promise<{ id: string }> }, adminOverride?: { id: string; name?: string | null }) {
  try {
    // The cron worker calls this module-private handler only after claiming
    // a durable admin-approved job. The public POST still requires a session.
    const admin = adminOverride || await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, level: true, programId: true, specializationProgramId: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    if (body?.action === 'BACKGROUND_STATUS') {
      const saved = await readInternetBackgroundJob(id)
      return NextResponse.json({ ok: true, job: saved?.job ? {
        ...publicInternetJob(saved.job), axisProgress: await readInternetAxisProgress(saved.job),
      } : null }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body?.action === 'BACKGROUND_PAUSE') return pauseInternetBackgroundJob(id)
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    if (body?.action === 'BACKGROUND_START') return startInternetBackgroundJob(exam, admin, body)
    if (body?.action === 'BACKGROUND_RESUME') return resumeInternetBackgroundJob(id, admin)
    if (body?.action === 'PLAN') {
      if (!exam.specializationProgramId) return NextResponse.json({ error: 'الامتحان غير مربوط بتخصص علمي محدد' }, { status: 422 })
      const specialty = await db.program.findUnique({
        where: { id: exam.specializationProgramId },
        select: { titleAr: true, category: true,
          units: { where: { status: 'APPROVED' }, orderBy: [{ semester: 'asc' }, { order: 'asc' }], select: { title: true } },
        },
      })
      if (!specialty) return NextResponse.json({ error: 'لم يُعثر على تخصص الامتحان' }, { status: 422 })
      try {
        const plan = await suggestComprehensiveInternetPlan({ specialtyTitle: specialty.titleAr, category: specialty.category,
          approvedUnitTitles: specialty.units.map((unit) => unit.title) })
        return NextResponse.json({ ...plan, specialtyTitle: specialty.titleAr, needsReview: true })
      } catch (error: any) {
        console.error('comprehensive exam internet blueprint error:', error)
        return NextResponse.json({ error: 'تعذّر إعداد محاور التخصص. يمكنك كتابتها يدوياً أو إعادة المحاولة بعد فحص مزود التوليد.' }, { status: 502 })
      }
    }
    const topic = String(body?.topic || '').trim()
    if (!topic) {
      return NextResponse.json({ error: 'اكتب موضوع البحث أولاً' }, { status: 400 })
    }
    const specialty = await db.program.findUnique({
      where: { id: exam.specializationProgramId || exam.programId },
      select: { titleAr: true },
    })
    const specialtyTitle = specialty?.titleAr || exam.title
    const topicIssue = internetAcademicTopicIssue(topic, specialtyTitle)
    if (topicIssue) {
      return NextResponse.json({ error: topicIssue, code: 'ACADEMIC_TOPIC_REQUIRED' }, { status: 422 })
    }
    const comprehensive = body?.mode === 'COMPREHENSIVE'
    const axisTarget = Number(body?.axisTarget)
    if (comprehensive && (!exam.specializationProgramId || !Number.isInteger(axisTarget) || axisTarget < 1 || axisTarget > 100)) {
      return NextResponse.json({ error: 'خطة الامتحان الشامل تتطلب تخصصاً ومحوراً بعدد أسئلة مستهدف صحيح' }, { status: 400 })
    }
    let count = clampInternetQuestionCount(body?.count)
    if (comprehensive) {
      // Repeating a partial batch is safe: count what is already saved
      // under this axis, and never silently overfill the 100-question exam.
      const [existingForAxis, totalEligible] = await Promise.all([
        db.comprehensiveExamQuestion.count({ where: { examId: id, source: 'AI_INTERNET', sourceBookId: internetSourceId(topic), status: { in: ['APPROVED', 'PENDING_REVIEW'] } } }),
        db.comprehensiveExamQuestion.count({ where: { examId: id, status: { in: ['APPROVED', 'PENDING_REVIEW'] } } }),
      ])
      count = Math.min(count, axisTarget - existingForAxis, COMPREHENSIVE_EXAM_QUESTION_COUNT - totalEligible)
      if (count <= 0) {
        return NextResponse.json({ ok: true, imported: 0, requested: 0, accepted: 0, rejected: [], rejectedCount: 0, skipped: true,
          examFull: totalEligible >= COMPREHENSIVE_EXAM_QUESTION_COUNT,
          axisRemaining: Math.max(0, axisTarget - existingForAxis),
          search: { topic, resultsFound: 0, chunksUsed: 0, creditsUsed: 0 } })
      }
    }
    const apiKey = await readTavilyApiKey()
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'لم يُحفظ مفتاح Tavily بعد — احفظ مفتاحاً مجانياً من tavily.com (حساب مجاني من غير بطاقة) في لوحة الإدارة → النظام → مزوّدو النصوص والمفاتيح → بحث الإنترنت للامتحان الشامل (Tavily)، ثم أعد المحاولة',
          code: 'TAVILY_KEY_MISSING',
        },
        { status: 422 },
      )
    }
    let search
    let distinctDomains = 0
    try {
      if (comprehensive) {
        // Three independent advanced searches for this *one selected axis*:
        // theory, research evidence, professional cases. A single website
        // or generic admission brochure cannot drive a doctoral exam.
        const queries = buildSpecialtyResearchQueries(topic, specialtyTitle)
        const outcomes = await Promise.all(queries.map((query) => searchTavily({
          apiKey, query, searchDepth: 'advanced', chunksPerSource: 3,
          maxResults: Math.min(8, INTERNET_MAX_SEARCH_RESULTS),
        })))
        const diverse = diverseInternetEvidence(outcomes.map((outcome) => outcome.results))
        distinctDomains = diverse.distinctDomains
        const reportedCredits = outcomes.map((outcome) => outcome.creditsUsed).filter((value): value is number => typeof value === 'number')
        search = {
          results: diverse.results,
          creditsUsed: reportedCredits.length === outcomes.length ? reportedCredits.reduce((sum, credits) => sum + credits, 0) : null,
        }
      } else {
        search = await searchTavily({ apiKey, query: exam.specializationProgramId ? buildSpecialtyInternetQuery(topic, specialtyTitle) : topic, maxResults: INTERNET_MAX_SEARCH_RESULTS })
      }
    } catch (e: any) {
      const kind = e instanceof TavilySearchError ? e.kind : 'SERVER'
      console.error('comprehensive exam internet search error:', e)
      return NextResponse.json(
        { error: String(e?.message || 'تعذر البحث عبر الإنترنت — حاول لاحقاً'), code: 'TAVILY_SEARCH_FAILED', tavilyErrorKind: kind },
        { status: 502 },
      )
    }
    if (comprehensive && (search.results.length < 6 || distinctDomains < 3)) {
      return NextResponse.json({
        error: 'المراجع العلمية غير متنوعة أو غير كافية لهذا المحور: نحتاج 6 مقاطع صالحة على الأقل من 3 مواقع مستقلة؛ جرّب تنقيح اسم المحور.',
        code: 'INADEQUATE_SOURCE_DIVERSITY',
        search: { topic, resultsFound: search.results.length, distinctDomains, creditsUsed: search.creditsUsed },
      }, { status: 422 })
    }
    if (!search.results.length) {
      return NextResponse.json(
        {
          error: 'لم يعثر البحث عبر الإنترنت على نتائج لهذا الموضوع — جرّب صياغة أخرى للموضوع',
          code: 'INTERNET_NO_RESULTS',
          search: { topic, resultsFound: 0, chunksUsed: 0, creditsUsed: search.creditsUsed },
        },
        { status: 422 },
      )
    }
    const previous = await db.comprehensiveExamQuestion.findMany({
      where: { examId: id },
      select: { text: true },
      orderBy: { order: 'asc' },
    })
    let generated
    try {
      generated = await generateInternetQuestions(
        search.results,
        {
          topic,
          programTitleAr: specialtyTitle,
          programLevel: exam.level,
          count,
          comprehensive,
          previousQuestionTexts: previous.map((q: any) => q.text),
        },
      )
    } catch (e: any) {
      if (e?.code === 'INSUFFICIENT_SOURCE') {
        return NextResponse.json(
          {
            error: String(e?.message || 'نتائج البحث غير كافية لتوليد أسئلة موثّقة'),
            code: 'INSUFFICIENT_SOURCE',
            search: { topic, resultsFound: search.results.length, chunksUsed: 0, creditsUsed: search.creditsUsed },
          },
          { status: 422 },
        )
      }
      console.error('comprehensive exam internet generation error:', e)
      return NextResponse.json({ error: `تعذر توليد الأسئلة من نتائج البحث: ${String(e?.message || e).slice(0, 300)}` }, { status: 502 })
    }
    if (!generated.questions.length) {
      return NextResponse.json(
        {
          error: 'لم ينجُ أي سؤال مولَّد من التحقق بالدليل — جرّب صياغة أخرى للموضوع أو عدّداً أقل من الأسئلة',
          rejected: generated.rejected,
          rejectedCount: generated.rejectedCount,
          search: {
            topic,
            resultsFound: generated.search.resultsFound,
            chunksUsed: generated.search.chunksUsed,
            creditsUsed: search.creditsUsed,
          },
        },
        { status: 422 },
      )
    }
    // Only the short final write holds the exam lock. Every internet batch
    // sees earlier commits before reserving slots, order numbers and texts.
    const sourceId = internetSourceId(topic)
    const saved = await db.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "ComprehensiveExam" WHERE id = ${id} FOR UPDATE
      `
      if (current?.status !== 'DRAFT') return { statusChanged: true } as const
      const existing = await tx.comprehensiveExamQuestion.findMany({
        where: { examId: id },
        select: { order: true, text: true, status: true, source: true, sourceBookId: true },
      })
      const eligible = existing.filter((q) => q.status === 'APPROVED' || q.status === 'PENDING_REVIEW')
      const axisCount = eligible.filter((q) => q.source === 'AI_INTERNET' && q.sourceBookId === sourceId).length
      const freeSlots = COMPREHENSIVE_EXAM_QUESTION_COUNT - eligible.length
      const permitted = comprehensive ? Math.max(0, Math.min(count, axisTarget - axisCount, freeSlots)) : count
      const seen = new Set(existing.map((q) => normalizeArabic(q.text)))
      const unique = generated.questions.filter((q) => {
        const key = normalizeArabic(q.text)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const batch = unique.slice(0, permitted)
      if (batch.length) {
        let order = existing.reduce((max, q) => Math.max(max, q.order), 0)
        await tx.comprehensiveExamQuestion.createMany({
          data: batch.map((q) => ({
            examId: id, order: ++order, type: q.type, text: q.text,
            options: JSON.stringify(q.options), correctAnswer: q.correctAnswer,
            source: 'AI_INTERNET', sourceBookId: sourceId, sourceEvidence: q.sourceEvidence,
            sourceUrl: q.sourceUrl || null, status: 'PENDING_REVIEW', createdById: admin.id,
          })),
        })
      }
      return { imported: batch.length, permitted, axisRemaining: Math.max(0, axisTarget - axisCount - batch.length),
        examFull: freeSlots <= batch.length }
    }, { isolationLevel: 'ReadCommitted' })
    if (saved.statusChanged) {
      return NextResponse.json({ error: 'تغيّرت حالة الامتحان أثناء التوليد؛ يجب أن يكون مسودة لحفظ الأسئلة.', code: 'EXAM_STATUS_CHANGED' }, { status: 409 })
    }
    if (!saved.imported && saved.permitted) {
      return NextResponse.json({ error: 'الأسئلة المولّدة مكررة في الامتحان؛ جرّب تنقيح المحور.', code: 'DUPLICATE_OF_EXISTING_QUESTION' }, { status: 422 })
    }
    const truncated = generated.questions.length - saved.imported
    await audit(
      { id: admin.id, name: admin.name || 'Admin' },
      'GENERATE_COMPREHENSIVE_EXAM_QUESTIONS_FROM_INTERNET',
      'ComprehensiveExam',
      id,
      `توليد ${saved.imported} سؤالاً من بحث الإنترنت (Tavily) عن «${topic}» (${generated.search.resultsFound} نتيجة، ${generated.search.chunksUsed} مقطعاً) إلى الامتحان الشامل «${exam.title}» — كلها بانتظار المراجعة؛ ${generated.rejectedCount + truncated} سؤالاً لم يُحفظ بعد التدقيق والسقف`,
    )
    return NextResponse.json({
      ok: true,
      source: 'AI_INTERNET',
      imported: saved.imported,
      requested: generated.requested,
      accepted: saved.imported,
      ...(comprehensive ? { axisRemaining: saved.axisRemaining, examFull: saved.examFull, skipped: !saved.permitted } : {}),
      rejected: generated.rejected,
      rejectedCount: generated.rejectedCount + truncated,
      provider: generated.provider || null,
      model: generated.model || null,
      search: {
        topic,
        resultsFound: generated.search.resultsFound,
        chunksUsed: generated.search.chunksUsed,
        creditsUsed: search.creditsUsed,
        ...(comprehensive ? { distinctDomains, researchDirections: 3 } : {}),
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam internet error:', e)
    return NextResponse.json({ error: 'تعذر توليد الأسئلة من البحث عبر الإنترنت' }, { status: 500 })
  }
}

// Public requests always authenticate through requireAdmin. Only the cron
// worker below may reuse the same guarded generation/save path with the
// administrator identity persisted when the reviewed blueprint was queued.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handleInternetPost(req, ctx)
}

const INTERNET_JOB_PREFIX = 'COMPREHENSIVE_INTERNET_JOB_V1:'
const INTERNET_JOB_LEASE_MS = 330_000 // longer than the function's 300s limit
type InternetJobStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_WITH_GAPS'
type InternetJobAxis = { topic: string; target: number; attempts: number; stalled: number }
type InternetBackgroundJob = {
  version: 1
  examId: string
  adminId: string
  adminName: string
  status: InternetJobStatus
  axes: InternetJobAxis[]
  axisIndex: number
  imported: number
  errors: string[]
  leaseId: string | null
  lockedUntil: string | null
  retryAt: string | null
  updatedAt: string
}

function internetJobKey(examId: string) { return `${INTERNET_JOB_PREFIX}${examId}` }

function parseInternetJob(raw: string): InternetBackgroundJob | null {
  try {
    const job = JSON.parse(raw) as InternetBackgroundJob
    if (job?.version !== 1 || !job.examId || !Array.isArray(job.axes) || job.axes.length < 1 || job.axes.length > 10) return null
    if (!['QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_GAPS'].includes(job.status)) return null
    if (job.axes.some((a) => typeof a.topic !== 'string' || a.topic.length < 10 || a.topic.length > 160 || !Number.isInteger(a.target) || a.target < 1)) return null
    if (!Number.isInteger(job.axisIndex) || job.axisIndex < 0 || job.axisIndex > job.axes.length) return null
    return job
  } catch { return null }
}

function publicInternetJob(job: InternetBackgroundJob) {
  return {
    status: job.status, axes: job.axes.map(({ topic, target }) => ({ topic, target })),
    axis: Math.min(job.axisIndex + 1, job.axes.length), total: job.axes.length,
    imported: job.imported, errors: job.errors, retryAt: job.retryAt, updatedAt: job.updatedAt,
  }
}

// Show saved, academically eligible questions per axis. This is derived from
// the authoritative question rows, so it also reflects edits and approvals
// made outside the background worker and survives tab/device changes.
async function readInternetAxisProgress(job: InternetBackgroundJob) {
  const sourceIds = job.axes.map((axis) => internetSourceId(axis.topic))
  const groups = await db.comprehensiveExamQuestion.groupBy({
    by: ['sourceBookId'],
    where: { examId: job.examId, source: 'AI_INTERNET', sourceBookId: { in: sourceIds }, status: { in: ['APPROVED', 'PENDING_REVIEW'] } },
    _count: { _all: true },
  })
  const savedBySource = new Map(groups.map((group) => [group.sourceBookId, group._count._all]))
  return job.axes.map((axis, index) => {
    const saved = Math.min(axis.target, savedBySource.get(sourceIds[index]) || 0)
    return { topic: axis.topic, target: axis.target, saved, remaining: Math.max(0, axis.target - saved) }
  })
}

async function readInternetBackgroundJob(examId: string) {
  const row = await db.setting.findUnique({ where: { key: internetJobKey(examId) } })
  return row ? { raw: row.value, job: parseInternetJob(row.value) } : null
}

// Compare-and-swap prevents two administrators or overlapping cron ticks from
// overwriting each other's job state. Questions themselves are saved by the
// existing transaction in handleInternetPost, which rechecks 100/axis caps.
async function replaceInternetJob(examId: string, previousRaw: string, next: InternetBackgroundJob) {
  const result = await db.setting.updateMany({
    where: { key: internetJobKey(examId), value: previousRaw },
    data: { value: JSON.stringify(next) },
  })
  return result.count === 1
}

async function startInternetBackgroundJob(
  exam: { id: string; status: string; specializationProgramId: string | null },
  admin: { id: string; name?: string | null },
  body: any,
) {
  if (exam.status !== 'DRAFT' || !exam.specializationProgramId) {
    return NextResponse.json({ error: 'يجب أن يكون الامتحان مسودة مرتبطة بتخصص علمي' }, { status: 409 })
  }
  if (body?.reviewed !== true || !Array.isArray(body.axes) || body.axes.length < 1 || body.axes.length > 10) {
    return NextResponse.json({ error: 'راجع محاور التخصص وحدد من 1 إلى 10 محاور قبل التشغيل' }, { status: 422 })
  }
  const axes = body.axes.map((axis: unknown) => String(axis || '').trim()) as string[]
  if (axes.some((axis) => axis.length < 10 || axis.length > 160) || new Set(axes.map((axis) => axis.normalize('NFKC').toLowerCase())).size !== axes.length) {
    return NextResponse.json({ error: 'المحاور غير صالحة أو مكررة' }, { status: 422 })
  }
  const specialty = await db.program.findUnique({ where: { id: exam.specializationProgramId }, select: { titleAr: true } })
  if (!specialty) return NextResponse.json({ error: 'تخصص الامتحان غير موجود' }, { status: 422 })
  for (const axis of axes) {
    const issue = internetAcademicTopicIssue(axis, specialty.titleAr)
    if (issue) return NextResponse.json({ error: issue, code: 'ACADEMIC_TOPIC_REQUIRED' }, { status: 422 })
  }
  if (!await readTavilyApiKey()) return NextResponse.json({ error: 'مفتاح Tavily غير محفوظ', code: 'TAVILY_KEY_MISSING' }, { status: 422 })
  const existing = await readInternetBackgroundJob(exam.id)
  if (existing?.job && (existing.job.status === 'QUEUED' ||
    (existing.job.status === 'RUNNING' && !!existing.job.lockedUntil && new Date(existing.job.lockedUntil).getTime() > Date.now()))) {
    return NextResponse.json({ error: 'توليد الامتحان يعمل بالفعل في الخلفية', code: 'INTERNET_JOB_ACTIVE', job: publicInternetJob(existing.job) }, { status: 409 })
  }
  const perAxis = Math.floor(COMPREHENSIVE_EXAM_QUESTION_COUNT / axes.length)
  const job: InternetBackgroundJob = {
    version: 1, examId: exam.id, adminId: admin.id, adminName: admin.name || 'Admin',
    status: 'QUEUED', axes: axes.map((topic, index) => ({ topic, target: perAxis + (index < COMPREHENSIVE_EXAM_QUESTION_COUNT % axes.length ? 1 : 0), attempts: 0, stalled: 0 })),
    axisIndex: 0, imported: 0, errors: [], leaseId: null, lockedUntil: null, retryAt: null,
    updatedAt: new Date().toISOString(),
  }
  if (existing) {
    if (!await replaceInternetJob(exam.id, existing.raw, job)) {
      return NextResponse.json({ error: 'تغيّرت حالة وظيفة التوليد؛ حدّث الصفحة وحاول مجدداً' }, { status: 409 })
    }
  } else {
    try { await db.setting.create({ data: { key: internetJobKey(exam.id), value: JSON.stringify(job) } }) }
    catch (error: any) {
      if (error?.code === 'P2002') return NextResponse.json({ error: 'بدأ توليد آخر لهذا الامتحان بالفعل' }, { status: 409 })
      throw error
    }
  }
  console.info('[comprehensive-internet-job] queued', { examId: exam.id, axes: axes.length })
  return NextResponse.json({ ok: true, job: publicInternetJob(job) })
}

async function pauseInternetBackgroundJob(examId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readInternetBackgroundJob(examId)
    if (!current?.job) return NextResponse.json({ error: 'لا توجد مهمة توليد لهذا الامتحان' }, { status: 404 })
    if (!['QUEUED', 'RUNNING'].includes(current.job.status)) return NextResponse.json({ ok: true, job: publicInternetJob(current.job) })
    const next: InternetBackgroundJob = { ...current.job, status: 'PAUSED', retryAt: null, updatedAt: new Date().toISOString() }
    if (await replaceInternetJob(examId, current.raw, next)) return NextResponse.json({ ok: true, job: publicInternetJob(next) })
  }
  return NextResponse.json({ error: 'تغيّرت المهمة أثناء الإيقاف؛ أعد المحاولة' }, { status: 409 })
}

// Resume the SAME reviewed distribution rather than recomputing the targets
// from whatever axes happen to be selected in a browser. Completed axes are
// skipped by the existing idempotent saver at no search/model cost.
async function resumeInternetBackgroundJob(examId: string, admin: { id: string; name?: string | null }) {
  const current = await readInternetBackgroundJob(examId)
  if (!current?.job) return NextResponse.json({ error: 'لا توجد مهمة محفوظة لاستكمالها' }, { status: 404 })
  if (!['PAUSED', 'COMPLETED_WITH_GAPS'].includes(current.job.status)) {
    return NextResponse.json({ error: 'يمكن الاستكمال فقط بعد الإيقاف أو عند وجود محاور ناقصة' }, { status: 409 })
  }
  if (current.job.leaseId && current.job.lockedUntil && new Date(current.job.lockedUntil).getTime() > Date.now()) {
    return NextResponse.json({ error: 'الدفعة السابقة ما زالت قيد الإنهاء؛ انتظر قليلاً ثم استكمل' }, { status: 409 })
  }
  const progress = await readInternetAxisProgress(current.job)
  const firstMissingAxis = progress.findIndex((axis) => axis.remaining > 0)
  if (firstMissingAxis < 0) return NextResponse.json({ error: 'اكتملت حصص جميع المحاور بالفعل؛ راجع الأسئلة واعتمدها' }, { status: 409 })
  if (!await readTavilyApiKey()) return NextResponse.json({ error: 'مفتاح Tavily غير محفوظ', code: 'TAVILY_KEY_MISSING' }, { status: 422 })
  const next: InternetBackgroundJob = {
    ...current.job, adminId: admin.id, adminName: admin.name || 'Admin', status: 'QUEUED', axisIndex: firstMissingAxis,
    axes: current.job.axes.map((axis) => ({ ...axis, attempts: 0, stalled: 0 })),
    errors: [], leaseId: null, lockedUntil: null, retryAt: null, updatedAt: new Date().toISOString(),
  }
  if (!await replaceInternetJob(examId, current.raw, next)) {
    return NextResponse.json({ error: 'تغيّرت حالة التوليد أثناء الاستكمال؛ حدّث الصفحة وحاول مجدداً' }, { status: 409 })
  }
  console.info('[comprehensive-internet-job] resumed', { examId, axes: next.axes.length })
  return NextResponse.json({ ok: true, job: publicInternetJob(next) })
}

// Invoked only by the CRON_SECRET-protected scheduled route. One tick does
// one batch; a lease recovers after function termination and the saved
// per-axis question counts make retries idempotent. No browser is required.
export async function runNextComprehensiveInternetBackgroundStep() {
  const rows = await db.setting.findMany({
    where: {
      key: { startsWith: INTERNET_JOB_PREFIX },
      OR: [{ value: { contains: '"status":"QUEUED"' } }, { value: { contains: '"status":"RUNNING"' } }],
    },
    orderBy: { updatedAt: 'asc' }, take: 100,
  })
  const now = Date.now()
  for (const row of rows) {
    const job = parseInternetJob(row.value)
    if (!job || internetJobKey(job.examId) !== row.key || !['QUEUED', 'RUNNING'].includes(job.status)) continue
    if (job.status === 'RUNNING' && job.lockedUntil && new Date(job.lockedUntil).getTime() > now) continue
    if (job.retryAt && new Date(job.retryAt).getTime() > now) continue
    const leaseId = randomUUID()
    const claimed: InternetBackgroundJob = { ...job, status: 'RUNNING', leaseId, lockedUntil: new Date(now + INTERNET_JOB_LEASE_MS).toISOString(), updatedAt: new Date().toISOString() }
    if (!await replaceInternetJob(job.examId, row.value, claimed)) continue
    const owner = await db.user.findUnique({ where: { id: job.adminId }, select: { role: true, status: true } })
    if (!owner || owner.role !== 'ADMIN' || owner.status !== 'ACTIVE') {
      const blocked: InternetBackgroundJob = {
        ...claimed, status: 'PAUSED', leaseId: null, lockedUntil: null,
        errors: [...claimed.errors, 'توقّف التوليد لأن صلاحية المدير الذي بدأ المهمة لم تعد فعالة'],
        updatedAt: new Date().toISOString(),
      }
      if (await replaceInternetJob(job.examId, JSON.stringify(claimed), blocked)) return publicInternetJob(blocked)
      return null
    }
    const axis = claimed.axes[claimed.axisIndex]
    let responseStatus = 500
    let response: any = {}
    if (axis) {
      try {
        const res = await handleInternetPost(new NextRequest(`http://localhost/api/admin/comprehensive-exams/${job.examId}/questions/from-internet`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'COMPREHENSIVE', topic: axis.topic, count: Math.min(10, axis.target), axisTarget: axis.target }),
        }), { params: Promise.resolve({ id: job.examId }) }, { id: job.adminId, name: job.adminName })
        responseStatus = res.status
        response = await res.json().catch(() => ({}))
      } catch (error: any) {
        response = { error: String(error?.message || 'خطأ أثناء تشغيل العامل').slice(0, 180), code: 'WORKER_ERROR' }
      }
    }
    // A pause may have been requested while the current batch was running.
    // Preserve that command and the resulting saved questions together.
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await readInternetBackgroundJob(job.examId)
      if (!latest?.job || latest.job.leaseId !== leaseId) break
      const next: InternetBackgroundJob = { ...latest.job, axes: latest.job.axes.map((a) => ({ ...a })), updatedAt: new Date().toISOString(), lockedUntil: null, leaseId: null, retryAt: null }
      if (!axis) {
        next.status = next.errors.length ? 'COMPLETED_WITH_GAPS' : 'COMPLETED'
      } else {
        const currentAxis = next.axes[next.axisIndex]
        const imported = Number(response?.imported || 0)
        next.imported += Math.max(0, imported)
        currentAxis.attempts++
        currentAxis.stalled = imported > 0 ? 0 : currentAxis.stalled + 1
        const remaining = Number(response?.axisRemaining ?? currentAxis.target)
        const hardFailure = responseStatus === 401 || responseStatus === 409 ||
          response?.code === 'TAVILY_KEY_MISSING' || (response?.code === 'TAVILY_SEARCH_FAILED' && ['AUTH', 'PLAN_LIMIT'].includes(response?.tavilyErrorKind))
        const sourceFailure = responseStatus === 422 && ['INADEQUATE_SOURCE_DIVERSITY', 'INSUFFICIENT_SOURCE', 'ACADEMIC_TOPIC_REQUIRED', 'DUPLICATE_OF_EXISTING_QUESTION'].includes(response?.code)
        const message = String(response?.error || 'الأسئلة الموثقة غير كافية في هذا المحور').slice(0, 180)
        if (hardFailure) {
          next.errors.push(`«${axis.topic}»: ${message}`)
          next.status = 'PAUSED'
        } else if (response?.examFull) {
          next.axisIndex = next.axes.length
          if (remaining <= 0 && claimed.axisIndex === next.axes.length - 1 && !next.errors.length) {
            next.status = 'COMPLETED'
          } else {
            next.status = 'COMPLETED_WITH_GAPS'
            next.errors.push('وصل الامتحان إلى سقف 100 سؤال قبل إكمال حصص بعض المحاور')
          }
        } else if (responseStatus === 200 && remaining <= 0) {
          next.axisIndex++
        } else if (sourceFailure || currentAxis.attempts >= axis.target + 6 || currentAxis.stalled >= 5) {
          next.errors.push(`«${axis.topic}»: ${responseStatus === 200 ? `ينقص ${Math.max(0, remaining)} سؤالاً موثقاً` : message}`)
          next.axisIndex++
        } else if (responseStatus !== 200) {
          next.retryAt = new Date(Date.now() + Math.min(600_000, 60_000 * 2 ** Math.min(currentAxis.stalled, 3))).toISOString()
        }
        if (next.axisIndex >= next.axes.length && next.status !== 'PAUSED') next.status = next.errors.length ? 'COMPLETED_WITH_GAPS' : 'COMPLETED'
        else if (next.status !== 'PAUSED') next.status = 'QUEUED'
      }
      if (latest.job.status === 'PAUSED') next.status = 'PAUSED'
      if (await replaceInternetJob(job.examId, latest.raw, next)) {
        console.info('[comprehensive-internet-job] step', { examId: job.examId, axis: claimed.axisIndex + 1, imported: response?.imported || 0, responseStatus, code: response?.code || null, status: next.status })
        return publicInternetJob(next)
      }
    }
    console.error('[comprehensive-internet-job] could not checkpoint', { examId: job.examId, leaseId })
    return null // the lease expires; the next tick recounts saved questions
  }
  return null
}
