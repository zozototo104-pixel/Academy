import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'

const MAX_FILE_SIZE = 6 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/png',
  'image/jpeg',
])

function dueDateFrom(enrolledAt: Date, dueDays?: number | null) {
  if (!dueDays) return null
  const d = new Date(enrolledAt)
  d.setDate(d.getDate() + dueDays)
  return d
}

function mapAssignment(a: any, enrollmentCreatedAt: Date) {
  const dueAt = dueDateFrom(enrollmentCreatedAt, a.dueDays)
  const submission = a.submissions?.[0] || null
  return {
    id: a.id,
    programId: a.programId,
    programTitle: a.program?.titleAr,
    title: a.title,
    description: a.description,
    semester: a.semester,
    type: a.type,
    points: a.points,
    weight: a.weight,
    dueDays: a.dueDays,
    dueAt,
    rubric: a.rubric,
    status: a.status,
    submitted: !!submission,
    submission: submission ? {
      id: submission.id,
      answerText: submission.answerText,
      fileName: submission.fileName,
      mimeType: submission.mimeType,
      size: submission.size,
      status: submission.status,
      score: submission.score,
      feedback: submission.feedback,
      submittedAt: submission.submittedAt,
      gradedAt: submission.gradedAt,
    } : null,
  }
}

// GET /api/assignments?programId=xxx — واجبات الطالب المنشورة في برامجه
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const programId = req.nextUrl.searchParams.get('programId') || undefined
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id, status: { in: ['ACTIVE', 'COMPLETED'] }, ...(programId ? { programId } : {}) },
      select: { programId: true, createdAt: true },
    })
    const enrollmentMap = new Map(enrollments.map((e) => [e.programId, e.createdAt]))
    const programIds = enrollments.map((e) => e.programId)
    if (programIds.length === 0) return NextResponse.json({ assignments: [] })

    const assignments = await db.programAssignment.findMany({
      where: { programId: { in: programIds }, status: 'PUBLISHED' },
      orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
      include: {
        program: { select: { titleAr: true } },
        submissions: { where: { userId: user.id }, take: 1 },
      },
    })

    return NextResponse.json({ assignments: assignments.map((a) => mapAssignment(a, enrollmentMap.get(a.programId) || new Date())) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('student assignments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الواجبات' }, { status: 500 })
  }
}

// POST /api/assignments — تسليم واجب، يدعم FormData أو JSON
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const contentType = req.headers.get('content-type') || ''
    let assignmentId = ''
    let answerText = ''
    let fileName: string | null = null
    let mimeType: string | null = null
    let size: number | null = null
    let data: string | null = null

    if (contentType.includes('multipart/form-data')) {
      const fd = await req.formData()
      assignmentId = String(fd.get('assignmentId') || '')
      answerText = String(fd.get('answerText') || '').trim().slice(0, 12000)
      const file = fd.get('file')
      if (file instanceof File && file.size > 0) {
        if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: 'حجم ملف الواجب كبير جداً؛ الحد الأقصى 6 ميجابايت' }, { status: 400 })
        if (!ALLOWED_MIME.has(file.type)) return NextResponse.json({ error: 'صيغة الملف غير مدعومة للواجبات' }, { status: 400 })
        const buffer = Buffer.from(await file.arrayBuffer())
        fileName = file.name.slice(0, 220)
        mimeType = file.type
        size = file.size
        data = buffer.toString('base64')
      }
    } else {
      const body = await req.json().catch(() => ({}))
      assignmentId = String(body.assignmentId || '')
      answerText = String(body.answerText || '').trim().slice(0, 12000)
    }

    if (!assignmentId) return NextResponse.json({ error: 'معرف الواجب مطلوب' }, { status: 400 })
    if (!answerText && !data) return NextResponse.json({ error: 'اكتب إجابتك أو أرفق ملف الواجب قبل التسليم' }, { status: 400 })

    const assignment = await db.programAssignment.findUnique({
      where: { id: assignmentId },
      include: { program: { select: { id: true, titleAr: true } } },
    })
    if (!assignment || assignment.status !== 'PUBLISHED') return NextResponse.json({ error: 'الواجب غير متاح للتسليم' }, { status: 404 })

    const enrollment = await db.enrollment.findFirst({ where: { userId: user.id, programId: assignment.programId, status: { in: ['ACTIVE', 'COMPLETED'] } } })
    if (!enrollment) return NextResponse.json({ error: 'هذا الواجب خاص ببرنامج غير مسجل في حسابك' }, { status: 403 })

    const submission = await db.assignmentSubmission.upsert({
      where: { assignmentId_userId: { assignmentId, userId: user.id } },
      update: {
        answerText: answerText || null,
        ...(fileName ? { fileName, mimeType, size, data } : {}),
        status: 'SUBMITTED',
        score: null,
        feedback: null,
        gradedAt: null,
        gradedBy: null,
        submittedAt: new Date(),
      },
      create: {
        assignmentId,
        userId: user.id,
        answerText: answerText || null,
        fileName,
        mimeType,
        size,
        data,
        status: 'SUBMITTED',
      },
    })

    const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    await Promise.all(admins.map((a) => notify(a.id, 'ASSIGNMENT', 'تسليم واجب جديد', `${user.name} سلّم واجب «${assignment.title}» في ${assignment.program.titleAr}`, 'admin')))

    return NextResponse.json({ submission })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('student assignments POST error:', e)
    return NextResponse.json({ error: 'تعذر تسليم الواجب' }, { status: 500 })
  }
}
