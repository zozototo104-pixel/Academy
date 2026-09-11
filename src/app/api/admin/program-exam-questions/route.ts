import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { notify } from '@/lib/notify'
import { emailExamPublished } from '@/lib/mailer'

const REQUIRED_PUBLISHED_QUESTIONS = 80
const DEFAULT_MIN_TYPE_DISTRIBUTION: Record<string, number> = { MCQ: 20, TF: 12, SHORT: 10, ESSAY: 8 }
const VALID_SKILLS = new Set(['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE'])
const VALID_DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

function cleanInternalExamMeta(value: unknown, max = 4000): string {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/[«"]?\s*\[\s*(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\s*(?:\|\s*(?:أهمية|اهمية)\s*\d{1,3})?\s*\]\s*[»"]?/giu, '')
    .replace(/\b(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\b\s*\|\s*(?:أهمية|اهمية)\s*\d{1,3}/giu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:：\-–—،؛]+|[\s:：\-–—،؛]+$/gu, '')
    .trim()
    .slice(0, max)
}

function cleanOptions(value: string | null): string | null {
  if (!value) return null
  try {
    const arr = JSON.parse(value)
    if (!Array.isArray(arr)) return value
    const cleaned = arr.map((o) => cleanInternalExamMeta(o, 500)).filter(Boolean)
    return cleaned.length ? JSON.stringify(cleaned) : value
  } catch {
    return value
  }
}

function parseJsonArray(value: string | null): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function cleanJsonArray(value: unknown, maxItems = 12): string | null {
  if (!Array.isArray(value)) return null
  const cleaned = value
    .map((item) => {
      if (typeof item === 'string') return cleanInternalExamMeta(item, 300)
      if (!item || typeof item !== 'object') return null
      const obj: any = {}
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (k === 'optionIndex' || k === 'index') obj.optionIndex = Number(v)
        else obj[k] = cleanInternalExamMeta(v, 500)
      }
      return Object.keys(obj).length ? obj : null
    })
    .filter(Boolean)
    .slice(0, maxItems)
  return cleaned.length ? JSON.stringify(cleaned) : null
}

function normalizeQuestionText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function minTypeDistributionForDegree(category?: string | null): Record<string, number> {
  if (category === 'DOCTORATE') return { MCQ: 16, TF: 8, SHORT: 18, ESSAY: 22 }
  if (category === 'DIPLOMA') return { MCQ: 30, TF: 18, SHORT: 18, ESSAY: 6 }
  if (category === 'ACCREDITATION' || category === 'INTL_CERT') return { MCQ: 30, TF: 16, SHORT: 16, ESSAY: 5 }
  return DEFAULT_MIN_TYPE_DISTRIBUTION
}

function validatePublicationReadiness(questions: any[], category?: string | null): string[] {
  const errors: string[] = []
  const candidates = questions.filter((q) => q.status !== 'REJECTED')
  if (candidates.length < REQUIRED_PUBLISHED_QUESTIONS) {
    errors.push(`عدد الأسئلة القابلة للنشر (${candidates.length}) أقل من المطلوب (${REQUIRED_PUBLISHED_QUESTIONS}).`)
  }

  for (const [type, min] of Object.entries(minTypeDistributionForDegree(category))) {
    const count = candidates.filter((q) => q.type === type).length
    if (count < min) errors.push(`تنوع الأسئلة غير كافٍ لهذه الدرجة: نوع ${type} عدده ${count} والمطلوب على الأقل ${min}.`)
  }

  const seen = new Map<string, number>()
  for (const q of candidates) {
    const key = normalizeQuestionText(q.text).slice(0, 180)
    if (!key) continue
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  const duplicateCount = Array.from(seen.values()).filter((n) => n > 1).length
  if (duplicateCount > 0) errors.push(`يوجد ${duplicateCount} سؤالاً أو أكثر بتكرار نصي محتمل؛ راجع التكرار قبل النشر.`)

  const missingSource = candidates.filter((q) =>
    !String(q.sourceEvidence || '').trim() ||
    !String(q.sourceBookTitle || '').trim() ||
    !String(q.sourceLocator || '').trim()
  ).length
  if (missingSource > 0) errors.push(`${missingSource} سؤالاً بلا مصدر أكاديمي مكتمل: اسم كتاب + دليل + موضع/مقطع.`)

  const missingMeasurement = candidates.filter((q) =>
    !VALID_SKILLS.has(String(q.cognitiveSkill || '')) ||
    !VALID_DIFFICULTIES.has(String(q.difficulty || '')) ||
    !String(q.correctRationale || '').trim()
  ).length
  if (missingMeasurement > 0) errors.push(`${missingMeasurement} سؤالاً بلا مهارة/صعوبة/تعليل إجابة مكتمل.`)

  const missingDistractors = candidates.filter((q) =>
    (q.type === 'MCQ' || q.type === 'TF') && parseJsonArray(q.distractorRationales).length === 0
  ).length
  if (missingDistractors > 0) errors.push(`${missingDistractors} سؤالاً موضوعياً بلا سبب خطأ للخيارات الأخرى.`)

  return errors.slice(0, 8)
}

// ===== 12.2 المراجعة البشرية للأسئلة المولدة بالذكاء الاصطناعي (Human-in-the-loop) =====
// GET ?examId= → كل الأسئلة مع إجاباتها النموذجية (للإدارة فقط)
// PATCH → تعديل سؤال / اعتماد / رفض / حذف سؤال
// POST { examId, action: 'APPROVE_ALL' } → اعتماد الكل ونشر الامتحان للطلاب

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const examId = req.nextUrl.searchParams.get('examId')
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { questions: { orderBy: { order: 'asc' } } },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    return NextResponse.json({
      exam: { id: exam.id, title: exam.title, status: exam.status, semester: exam.semester },
      questions: exam.questions.map((q) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: cleanInternalExamMeta(q.text, 3000),
        options: q.options ? JSON.parse(cleanOptions(q.options) || q.options) : null,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer ? cleanInternalExamMeta(q.modelAnswer, 4000) : q.modelAnswer,
        sourceEvidence: q.sourceEvidence ? cleanInternalExamMeta(q.sourceEvidence, 2500) : q.sourceEvidence,
        sourceBookTitle: q.sourceBookTitle,
        sourceChapter: q.sourceChapter,
        sourceLocator: q.sourceLocator,
        cognitiveSkill: q.cognitiveSkill,
        difficulty: q.difficulty,
        correctRationale: q.correctRationale,
        distractorRationales: parseJsonArray(q.distractorRationales),
        qualityFlags: parseJsonArray(q.qualityFlags),
        reviewNotes: q.reviewNotes,
        points: q.points,
        status: q.status,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الأسئلة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const {
      questionId,
      action,
      text,
      options,
      correctAnswer,
      modelAnswer,
      sourceEvidence,
      sourceBookTitle,
      sourceChapter,
      sourceLocator,
      cognitiveSkill,
      difficulty,
      correctRationale,
      distractorRationales,
      qualityFlags,
      reviewNotes,
      rejectedReason,
      points,
    } = await req.json()
    if (!questionId || !action) return NextResponse.json({ error: 'بيانات غير مكتملة' }, { status: 400 })

    const existing = await db.programQuestion.findUnique({ where: { id: questionId }, include: { exam: { select: { id: true, title: true } } } })
    if (!existing) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })

    if (action === 'EDIT') {
      const data: any = {}
      if (text != null && String(text).trim()) data.text = cleanInternalExamMeta(text, 3000)
      if (options != null) {
        const opts = (Array.isArray(options) ? options : []).map((o: any) => cleanInternalExamMeta(o, 500)).filter(Boolean)
        if (opts.length >= 2) data.options = JSON.stringify(opts)
      }
      if (correctAnswer != null) data.correctAnswer = String(correctAnswer)
      if (modelAnswer != null) data.modelAnswer = cleanInternalExamMeta(modelAnswer, 4000)
      if (sourceEvidence != null) data.sourceEvidence = cleanInternalExamMeta(sourceEvidence, 2500)
      if (sourceBookTitle != null) data.sourceBookTitle = cleanInternalExamMeta(sourceBookTitle, 300)
      if (sourceChapter != null) data.sourceChapter = cleanInternalExamMeta(sourceChapter, 180)
      if (sourceLocator != null) data.sourceLocator = cleanInternalExamMeta(sourceLocator, 500)
      if (cognitiveSkill != null && VALID_SKILLS.has(String(cognitiveSkill))) data.cognitiveSkill = String(cognitiveSkill)
      if (difficulty != null && VALID_DIFFICULTIES.has(String(difficulty))) data.difficulty = String(difficulty)
      if (correctRationale != null) data.correctRationale = cleanInternalExamMeta(correctRationale, 1200)
      if (distractorRationales != null) data.distractorRationales = cleanJsonArray(distractorRationales, 6)
      if (qualityFlags != null) data.qualityFlags = cleanJsonArray(qualityFlags, 12)
      if (reviewNotes != null) data.reviewNotes = cleanInternalExamMeta(reviewNotes, 1500)
      if (points != null && Number(points) > 0) data.points = Math.max(1, Math.min(50, Math.round(Number(points))))
      await db.programQuestion.update({ where: { id: questionId }, data })
      await audit({ id: admin.id, name: admin.name }, 'EDIT_EXAM_QUESTION', 'ProgramQuestion', questionId, existing.exam.title)
      return NextResponse.json({ ok: true })
    }

    if (action === 'APPROVE' || action === 'REJECT') {
      const approveData = action === 'APPROVE'
        ? {
            status: 'PUBLISHED',
            text: cleanInternalExamMeta(existing.text, 3000),
            options: cleanOptions(existing.options),
            modelAnswer: existing.modelAnswer ? cleanInternalExamMeta(existing.modelAnswer, 4000) : existing.modelAnswer,
            sourceEvidence: existing.sourceEvidence ? cleanInternalExamMeta(existing.sourceEvidence, 2500) : existing.sourceEvidence,
            approvedBy: admin.id,
            approvedAt: new Date(),
            rejectedReason: null,
          }
        : {
            status: 'REJECTED',
            rejectedReason: rejectedReason ? cleanInternalExamMeta(rejectedReason, 1000) : 'رفض إداري أثناء مراجعة الامتحان',
          }
      await db.programQuestion.update({
        where: { id: questionId },
        data: approveData,
      })
      await audit(
        { id: admin.id, name: admin.name },
        action === 'APPROVE' ? 'APPROVE_EXAM_QUESTION' : 'REJECT_EXAM_QUESTION',
        'ProgramQuestion',
        questionId,
        existing.exam.title
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'DELETE') {
      const examId = existing.exam.id
      await db.programQuestion.delete({ where: { id: questionId } })

      // إعادة ترتيب الأسئلة بعد الحذف حتى تبقى القائمة نظيفة ومتسلسلة للإدارة والطلاب
      const remaining = await db.programQuestion.findMany({
        where: { examId },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        select: { id: true, points: true },
      })
      for (let i = 0; i < remaining.length; i++) {
        await db.programQuestion.update({ where: { id: remaining[i].id }, data: { order: i + 1 } })
      }
      const totalPoints = remaining.reduce((sum, q) => sum + q.points, 0)
      await db.programExam.update({
        where: { id: examId },
        data: {
          totalPoints,
          durationMin: remaining.length > 0 ? Math.max(120, Math.min(240, Math.round(remaining.length * 2))) : 120,
        },
      })

      await audit({ id: admin.id, name: admin.name }, 'DELETE_EXAM_QUESTION', 'ProgramQuestion', questionId, existing.exam.title)
      return NextResponse.json({ ok: true, remaining: remaining.length, totalPoints })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { examId, action } = await req.json()
    if (!examId || action !== 'APPROVE_ALL') return NextResponse.json({ error: 'بيانات غير مكتملة' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { program: { select: { category: true, titleAr: true } }, questions: { select: { id: true, status: true } } },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    const publicationCandidates = await db.programQuestion.findMany({ where: { examId, status: { not: 'REJECTED' } } })
    const readinessErrors = validatePublicationReadiness(publicationCandidates, exam.program?.category)
    if (readinessErrors.length > 0) {
      return NextResponse.json(
        {
          error: 'لا يمكن نشر الامتحان قبل اكتمال معايير مصنع الامتحانات الأكاديمي',
          details: readinessErrors,
        },
        { status: 400 }
      )
    }

    // اعتماد كل الأسئلة المعلقة بعد تنظيف أي تسميات تقنية تسربت من بنك المعرفة.
    const pendingQuestions = await db.programQuestion.findMany({
      where: { examId, status: 'PENDING_REVIEW' },
      select: { id: true, text: true, options: true, modelAnswer: true, sourceEvidence: true },
    })
    for (const q of pendingQuestions) {
      await db.programQuestion.update({
        where: { id: q.id },
        data: {
          status: 'PUBLISHED',
          text: cleanInternalExamMeta(q.text, 3000),
          options: cleanOptions(q.options),
          modelAnswer: q.modelAnswer ? cleanInternalExamMeta(q.modelAnswer, 4000) : q.modelAnswer,
          sourceEvidence: q.sourceEvidence ? cleanInternalExamMeta(q.sourceEvidence, 2500) : q.sourceEvidence,
          approvedBy: admin.id,
          approvedAt: new Date(),
          rejectedReason: null,
        },
      })
    }
    const result = { count: pendingQuestions.length }

    const published = await db.programQuestion.count({ where: { examId, status: 'PUBLISHED' } })
    if (published < REQUIRED_PUBLISHED_QUESTIONS) {
      return NextResponse.json(
        { error: `عدد الأسئلة المعتمدة (${published}) لا يكفي لنشر الامتحان الكامل — المطلوب ${REQUIRED_PUBLISHED_QUESTIONS} سؤالاً. استخدم استكمال التوليد قبل النشر.` },
        { status: 400 }
      )
    }

    // إعادة حساب مجموع النقاط والمدة بعد الاعتماد
    const publishedQuestions = await db.programQuestion.findMany({ where: { examId, status: 'PUBLISHED' }, select: { points: true } })
    const totalPoints = publishedQuestions.reduce((s, q) => s + q.points, 0)
    const totalQ = publishedQuestions.length

    await db.programExam.update({
      where: { id: examId },
      data: {
        status: 'READY',
        totalPoints,
        durationMin: Math.max(120, Math.min(240, Math.round(totalQ * 2))),
      },
    })

    await audit(
      { id: admin.id, name: admin.name },
      'PUBLISH_PROGRAM_EXAM',
      'ProgramExam',
      examId,
      `اعتماد ونشر ${totalQ} سؤالاً (${result.count} سؤالاً اعتمدت الآن)`
    )

    // إشعار الطلاب اختياري ولا يجوز أن يفشل اعتماد الامتحان إذا تعطّل البريد أو جدول الإشعارات.
    let notified = 0
    try {
      const enrolled = await db.enrollment.findMany({
        where: { programId: exam.programId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        select: {
          userId: true,
          user: { select: { email: true, name: true } },
        },
      })
      notified = enrolled.length
      const semesterLabel = exam.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'
      const examDuration = Math.max(120, Math.min(240, Math.round(totalQ * 2)))
      Promise.allSettled(enrolled.map(async (en) => {
        await notify(
          en.userId,
          'GENERAL',
          `امتحان ${semesterLabel} متاح الآن`,
          `اعتمدت الإدارة أسئلة «${exam.title}» ونشرتها: ${totalQ} سؤالاً متنوعاً ومدة ${examDuration} دقيقة. راجع الكتب المقررة ثم ابدأ من بوابة الطالب.`,
          'dashboard'
        )
        if (en.user?.email) {
          await emailExamPublished(en.user.email, en.user.name, exam.title, totalQ, examDuration)
        }
      })).catch((err) => console.error('exam publish notifications failed:', err))
    } catch (notifyErr) {
      console.error('exam publish notification lookup failed:', notifyErr)
    }

    return NextResponse.json({ ok: true, published: totalQ, approvedNow: result.count, notified })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions POST error:', e)
    return NextResponse.json({ error: 'تعذر اعتماد الأسئلة' }, { status: 500 })
  }
}
