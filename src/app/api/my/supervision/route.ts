import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

function parseOptions(v: any): string[] {
  if (Array.isArray(v)) return v.map(String)
  try {
    const parsed = JSON.parse(String(v || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

export async function GET() {
  try {
    const user = await requireUser()
    if (user.role !== 'STUDENT') {
      return NextResponse.json({ supervision: [], active: null, restricted: true })
    }
    const apps = await db.admissionApplication.findMany({
      where: { OR: [{ userId: user.id }, { email: user.email }] },
      orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      include: {
        supervisor: { select: { id: true, name: true, email: true, phone: true } },
        programRef: { select: { id: true, titleAr: true, books: { select: { id: true, title: true, semester: true } } } },
        theses: { orderBy: { updatedAt: 'desc' }, take: 3, select: { id: true, title: true, status: true, updatedAt: true } },
      },
    })
    const rows = await Promise.all(apps.map(async (app: any) => {
      const [messages, assessments] = await Promise.all([
        db.supervisorChannelMessage.findMany({ where: { admissionId: app.id }, orderBy: { createdAt: 'asc' }, take: 100 }),
        db.supervisorAssessment.findMany({
          where: { admissionId: app.id, studentId: user.id, status: { in: ['PUBLISHED', 'CLOSED'] } },
          orderBy: { createdAt: 'desc' },
          include: {
            questions: { orderBy: { order: 'asc' } },
            attempts: { where: { studentId: user.id }, orderBy: { submittedAt: 'desc' }, take: 3, include: { answers: { include: { question: true } } } },
          },
        }),
      ])
      return {
        admission: {
          id: app.id,
          reference: app.reference,
          fullName: app.fullName,
          program: app.programRef?.titleAr || app.program,
          programId: app.programId,
          status: app.status,
          supervisionMode: app.supervisionMode || (app.supervisorId ? 'HUMAN' : 'AI'),
          supervisor: app.supervisor,
          thesisDeadline: app.thesisDeadline,
          books: app.programRef?.books || [],
          theses: app.theses || [],
        },
        messages,
        assessments: assessments.map((a: any) => ({
          ...a,
          sourceBookIds: a.sourceBookIds ? JSON.parse(a.sourceBookIds) : [],
          questions: a.questions.map((q: any) => ({ ...q, options: parseOptions(q.options) })),
        })),
      }
    }))
    return NextResponse.json({ supervision: rows, active: rows[0] || null })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('my supervision error:', e)
    return NextResponse.json({ error: 'تعذر تحميل متابعة المشرف' }, { status: 500 })
  }
}
