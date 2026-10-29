import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { auditLecture, canManageSession, notifyProgramStudents, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'

// POST /api/admin/lectures/sessions/[id]/cancel — إلغاء لقاء مع إشعار
// الطلاب. الصف يبقى بحالة CANCELLED حتى يراه الطلاب ملغيًا لا مختفيًا.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const session = await db.lectureSession.findUnique({
      where: { id },
      include: { series: { select: { supervisorId: true, programId: true } } },
    })
    if (!session) return NextResponse.json({ error: 'اللقاء غير موجود' }, { status: 404 })
    if (!canManageSession(actor, session, session.series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذا اللقاء' }, { status: 403 })
    }
    if (session.status === 'CANCELLED') {
      return NextResponse.json({ error: 'هذا اللقاء ملغي أصلًا' }, { status: 400 })
    }
    const updated = await db.lectureSession.update({
      where: { id },
      data: { status: 'CANCELLED', updatedById: actor.id },
    })
    await notifyProgramStudents(session.series.programId, {
      type: 'LECTURE_CANCELLED',
      title: 'إلغاء محاضرة',
      body: `أُلغيت محاضرة «${session.title}» التي كانت مقررة في ${session.startsAt.toISOString()}.`,
      emailSubject: 'إلغاء محاضرة في برنامجك',
    })
    await auditLecture(actor, 'LECTURE_SESSION_CANCELLED', 'LectureSession', id, {
      programId: session.series.programId,
    })
    return NextResponse.json({ session: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في إلغاء اللقاء' }, { status: 500 })
  }
}
