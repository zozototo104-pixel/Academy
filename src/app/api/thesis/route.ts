import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'
import { getExamsGate } from '@/lib/exam-gate'

function jsonArray(value: unknown, fallback: any[] = []) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return fallback
}

function mapThesisPlan(guide: any) {
  if (!guide) return null
  return {
    id: guide.id,
    title: guide.title,
    overview: guide.overview,
    objectives: jsonArray(guide.objectives),
    sections: jsonArray(guide.sections),
    activities: jsonArray(guide.activities),
    discussionQuestions: jsonArray(guide.discussionQuestions),
    updatedAt: guide.updatedAt,
  }
}

// GET /api/thesis — بحث التخرج الخاص بالمستخدم + بيانات طلب الالتحاق والمهلة
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ thesis: null, admission: null })
    const admission = await db.admissionApplication.findFirst({
      where: { OR: [{ userId: user.id }, { email: user.email }], status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      include: { supervisor: { select: { name: true } } },
    })
    const thesis = await db.thesisSubmission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      // select صريح: نستثني recordingData (تسجيل ثقيل حتى 24MB لا يُنقل مع فتح التبويب)
      select: {
        id: true,
        userId: true,
        admissionId: true,
        title: true,
        abstract: true,
        fileNote: true,
        status: true,
        defenseDate: true,
        committee: true,
        agentMember: true,
        defenseStatus: true,
        aiScore: true,
        aiRecommendation: true,
        defenseCompletedAt: true,
        defenseMinutes: true,
        recordingMime: true,
        recordingSize: true,
        recordingDurationSec: true,
        resultScore: true,
        passed: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const gate = await getExamsGate(user.id, admission?.programId)
    const thesisPlan = admission?.programId
      ? mapThesisPlan(await db.programStudyGuide.findFirst({
          where: { programId: admission.programId, semester: 3, status: 'PUBLISHED' },
          orderBy: { updatedAt: 'desc' },
        }))
      : null
    return NextResponse.json({
      thesis,
      thesisPlan,
      examsGate: gate,
      admission: admission
        ? {
            id: admission.id,
            reference: admission.reference,
            program: admission.program,
            status: admission.status,
            approvedAt: admission.approvedAt,
            thesisDeadline: admission.thesisDeadline,
            supervisorName: admission.supervisor?.name || null,
          }
        : null,
    })
  } catch (e) {
    console.error('thesis GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل بيانات بحث التخرج' }, { status: 500 })
  }
}

// POST /api/thesis — تسليم بحث التخرج (العنوان + الملخص)
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    const { title, abstract, fileNote, stage } = await req.json()
    const requestedStage = String(stage || 'FINAL').toUpperCase()
    if (!['PLAN', 'FINAL'].includes(requestedStage)) {
      return NextResponse.json({ error: 'مرحلة تسليم غير صحيحة' }, { status: 400 })
    }
    if (!title?.trim() || !abstract?.trim() || abstract.trim().length < 50) {
      return NextResponse.json(
        { error: 'عنوان البحث وملخص لا يقل عن 50 حرفاً مطلوبان' },
        { status: 400 }
      )
    }
    const admission = await db.admissionApplication.findFirst({
      where: { OR: [{ userId: user.id }, { email: user.email }], status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
    })

    // بوابة 1: لا تسليم بحث قبل التسجيل النهائي (سداد كامل + قبول إدارة) — إغلاق باب تجاوز الدفع
    // (SCHEDULED/RESULT_APPROVED لمن لديه بحث مسلم مسبقاً — منع التعديل يبقى من حالة البحث أدناه)
    if (!admission || !['SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED'].includes(admission.status)) {
      return NextResponse.json(
        { error: 'تسليم البحث متاح بعد التسجيل النهائي في البرنامج (سداد الرسوم وموافقة الإدارة)' },
        { status: 403 }
      )
    }

    // بوابة 2 (وفق مسار المنصة الرسمي): إنهاء جميع الامتحانات أولاً ثم تسليم البحث الذي يُناقش عبر الفيديو
    const gate = await getExamsGate(user.id, admission.programId)
    if (gate.hasAnyExam && !gate.complete) {
      const names = gate.missing.map((m) => m.title).join('، ')
      return NextResponse.json(
        { error: `يجب اجتياز جميع الامتحانات أولاً قبل تسليم بحث التخرج — المتبقي: ${names}` },
        { status: 403 }
      )
    }

    const existing = await db.thesisSubmission.findFirst({ where: { userId: user.id } })
    if (existing && ['SCHEDULED', 'RESULT_APPROVED'].includes(existing.status)) {
      return NextResponse.json({ error: 'بحثك قيد المناقشة أو تم اعتماد نتيجته — لا يمكن التعديل الآن' }, { status: 400 })
    }
    if (requestedStage === 'FINAL' && existing && existing.status === 'PLAN_SUBMITTED') {
      return NextResponse.json({ error: 'لا يمكن تسليم البحث النهائي قبل اعتماد خطة البحث من الإدارة/المشرف' }, { status: 403 })
    }
    if (requestedStage === 'FINAL' && !existing) {
      return NextResponse.json({ error: 'ابدأ أولاً بتسليم خطة البحث ثم انتظر اعتمادها قبل البحث النهائي' }, { status: 403 })
    }
    const nextStatus = requestedStage === 'PLAN' ? 'PLAN_SUBMITTED' : 'SUBMITTED'
    let thesis
    if (existing) {
      thesis = await db.thesisSubmission.update({
        where: { id: existing.id },
        data: {
          title: title.trim().slice(0, 300),
          abstract: abstract.trim().slice(0, 4000),
          fileNote: fileNote?.trim().slice(0, 600) || null,
          status: nextStatus,
        },
      })
    } else {
      thesis = await db.thesisSubmission.create({
        data: {
          userId: user.id,
          admissionId: admission.id,
          title: title.trim().slice(0, 300),
          abstract: abstract.trim().slice(0, 4000),
          fileNote: fileNote?.trim().slice(0, 600) || null,
          status: nextStatus,
        },
      })
    }
    if (admission.status === 'SUPERVISOR_ASSIGNED') {
      await db.admissionApplication.update({ where: { id: admission.id }, data: { status: 'THESIS' } })
    }
    await notify(
      user.id,
      'THESIS',
      'تم استلام بحث التخرج',
      `بحث «${thesis.title}» قيد المراجعة الأكاديمية. ستُبلّغ بموعد المناقشة أمام اللجنة المختصة — علماً أن المهلة القصوى 3-6 أشهر من تاريخ القبول.`,
      'dashboard'
    )
    await audit({ id: user.id, name: user.name }, 'SUBMIT_THESIS', 'ThesisSubmission', thesis.id, thesis.title)
    return NextResponse.json({ ok: true, thesis })
  } catch (e) {
    console.error('thesis POST error:', e)
    return NextResponse.json({ error: 'تعذر تسليم البحث' }, { status: 500 })
  }
}
