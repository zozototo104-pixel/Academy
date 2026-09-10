import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'

function asString(value: unknown, max = 3000) {
  return String(value || '').trim().slice(0, max)
}

function asInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function asStatus(value: unknown) {
  const v = asString(value, 30).toUpperCase()
  return ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(v) ? v : 'PUBLISHED'
}

function asType(value: unknown) {
  const v = asString(value, 40).toUpperCase()
  return ['REPORT', 'CASE_STUDY', 'SUMMARY', 'PROJECT', 'REFLECTION'].includes(v) ? v : 'REPORT'
}

function mapAssignment(a: any) {
  return {
    id: a.id,
    programId: a.programId,
    title: a.title,
    description: a.description,
    semester: a.semester,
    type: a.type,
    points: a.points,
    weight: a.weight,
    dueDays: a.dueDays,
    rubric: a.rubric,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    submissionsCount: a._count?.submissions || 0,
    submissions: (a.submissions || []).map((s: any) => ({
      id: s.id,
      userId: s.userId,
      studentName: s.user?.name,
      studentEmail: s.user?.email,
      answerText: s.answerText,
      fileName: s.fileName,
      mimeType: s.mimeType,
      size: s.size,
      status: s.status,
      score: s.score,
      feedback: s.feedback,
      submittedAt: s.submittedAt,
      gradedAt: s.gradedAt,
      updatedAt: s.updatedAt,
    })),
  }
}

// GET /api/admin/assignments?programId=xxx
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId')
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const assignments = await db.programAssignment.findMany({
      where: { programId },
      orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
      include: {
        _count: { select: { submissions: true } },
        submissions: {
          orderBy: { submittedAt: 'desc' },
          take: 25,
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    })

    return NextResponse.json({ assignments: assignments.map(mapAssignment) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin assignments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الواجبات' }, { status: 500 })
  }
}

// POST /api/admin/assignments — إنشاء/تعديل واجب
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = asString(body.id, 80)
    const programId = asString(body.programId, 80)
    const title = asString(body.title, 220)
    const description = asString(body.description, 6000)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    if (!title || !description) return NextResponse.json({ error: 'عنوان الواجب ووصفه مطلوبان' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const data = {
      programId,
      title,
      description,
      semester: asInt(body.semester, 1, 1, 3),
      type: asType(body.type),
      points: asInt(body.points, 10, 1, 100),
      weight: asInt(body.weight, 0, 0, 100),
      dueDays: body.dueDays === '' || body.dueDays == null ? null : asInt(body.dueDays, 14, 1, 365),
      rubric: asString(body.rubric, 4000) || null,
      status: asStatus(body.status),
    }

    let assignment
    if (id) {
      const existing = await db.programAssignment.findUnique({ where: { id }, select: { id: true, programId: true, status: true } })
      if (!existing || existing.programId !== programId) return NextResponse.json({ error: 'الواجب غير موجود لهذا البرنامج' }, { status: 404 })
      assignment = await db.programAssignment.update({ where: { id }, data })
      await audit(admin, 'UPDATE_ASSIGNMENT', 'ProgramAssignment', assignment.id, `تعديل واجب: ${assignment.title}`)
      if (existing.status !== 'PUBLISHED' && assignment.status === 'PUBLISHED') {
        const enrollments = await db.enrollment.findMany({ where: { programId, status: 'ACTIVE' }, select: { userId: true } })
        await Promise.all(enrollments.map((e) => notify(e.userId, 'ASSIGNMENT', 'واجب جديد منشور', `تم نشر واجب «${assignment.title}» في ${program.titleAr}`, 'dashboard')))
      }
    } else {
      assignment = await db.programAssignment.create({ data })
      await audit(admin, 'CREATE_ASSIGNMENT', 'ProgramAssignment', assignment.id, `إنشاء واجب: ${assignment.title}`)
      if (assignment.status === 'PUBLISHED') {
        const enrollments = await db.enrollment.findMany({ where: { programId, status: 'ACTIVE' }, select: { userId: true } })
        await Promise.all(enrollments.map((e) => notify(e.userId, 'ASSIGNMENT', 'واجب جديد', `تم إضافة واجب «${assignment.title}» ضمن ${program.titleAr}`, 'dashboard')))
      }
    }

    return NextResponse.json({ assignment })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin assignments POST error:', e)
    return NextResponse.json({ error: 'تعذر حفظ الواجب' }, { status: 500 })
  }
}

// PATCH /api/admin/assignments — تصحيح تسليم طالب
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const submissionId = asString(body.submissionId, 80)
    if (!submissionId) return NextResponse.json({ error: 'معرف التسليم مطلوب' }, { status: 400 })
    const score = body.score == null || body.score === '' ? null : Number(body.score)
    if (score != null && (!Number.isFinite(score) || score < 0)) return NextResponse.json({ error: 'درجة غير صالحة' }, { status: 400 })
    const feedback = asString(body.feedback, 4000)
    const status = asString(body.status, 30).toUpperCase()
    const finalStatus = ['GRADED', 'NEEDS_REVISION', 'SUBMITTED'].includes(status) ? status : 'GRADED'

    const existing = await db.assignmentSubmission.findUnique({
      where: { id: submissionId },
      include: { assignment: { include: { program: { select: { titleAr: true } } } }, user: { select: { id: true, name: true } } },
    })
    if (!existing) return NextResponse.json({ error: 'التسليم غير موجود' }, { status: 404 })
    const safeScore = score == null ? null : Math.min(score, existing.assignment.points)

    const submission = await db.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        score: safeScore,
        feedback: feedback || null,
        status: finalStatus,
        gradedBy: admin.name,
        gradedAt: finalStatus === 'SUBMITTED' ? null : new Date(),
      },
      include: { user: { select: { id: true, name: true, email: true } }, assignment: true },
    })

    await notify(
      submission.userId,
      'ASSIGNMENT',
      finalStatus === 'NEEDS_REVISION' ? 'واجب يحتاج تعديل' : 'تم تصحيح واجبك',
      `واجب «${submission.assignment.title}»: ${safeScore == null ? 'تمت المراجعة' : `${safeScore}/${submission.assignment.points}`}${feedback ? ` — ${feedback.slice(0, 120)}` : ''}`,
      'dashboard'
    )
    await audit(admin, 'GRADE_ASSIGNMENT', 'AssignmentSubmission', submission.id, `تصحيح واجب ${submission.assignment.title} للطالب ${existing.user.name}`)

    return NextResponse.json({ submission })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin assignments PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تصحيح الواجب' }, { status: 500 })
  }
}

// DELETE /api/admin/assignments?id=xxx
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'معرف الواجب مطلوب' }, { status: 400 })
    const existing = await db.programAssignment.findUnique({ where: { id }, select: { title: true } })
    await db.programAssignment.delete({ where: { id } })
    await audit(admin, 'DELETE_ASSIGNMENT', 'ProgramAssignment', id, `حذف واجب: ${existing?.title || id}`)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin assignments DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الواجب' }, { status: 500 })
  }
}
