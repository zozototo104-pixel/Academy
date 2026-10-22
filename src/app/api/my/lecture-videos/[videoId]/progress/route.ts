import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { canStudentAccessProgram } from '@/lib/lectures/access'

const progressSchema = z.object({
  positionSec: z.number().int().min(0),
  watchedPercent: z.number().int().min(0).max(100),
})

const COMPLETION_PERCENT = 95

// PUT /api/my/lecture-videos/[videoId]/progress — حفظ موضع المشاهدة ونسبتها.
// التقدم يُحفظ في جدول المحاضرات فقط ولا يؤثر في إكمال البرنامج أو الشهادات.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser()
    const { videoId } = await params

    const parsed = progressSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات تقدم غير صالحة' }, { status: 400 })
    }
    const { positionSec, watchedPercent } = parsed.data

    const video = await db.lectureVideoResource.findUnique({
      where: { id: videoId },
      select: { id: true, programId: true, status: true },
    })
    if (!video || video.status !== 'PUBLISHED') {
      return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    }
    if (!(await canStudentAccessProgram(user.id, video.programId))) {
      return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    }

    const existing = await db.lectureWatchProgress.findUnique({
      where: { videoId_userId: { videoId, userId: user.id } },
      select: { completedAt: true },
    })
    const completedAt =
      watchedPercent >= COMPLETION_PERCENT ? (existing?.completedAt ?? new Date()) : (existing?.completedAt ?? null)

    const saved = await db.lectureWatchProgress.upsert({
      where: { videoId_userId: { videoId, userId: user.id } },
      create: { videoId, userId: user.id, positionSec, watchedPercent, completedAt },
      update: { positionSec, watchedPercent, completedAt },
    })
    return NextResponse.json({
      positionSec: saved.positionSec,
      watchedPercent: saved.watchedPercent,
      completedAt: saved.completedAt,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في حفظ تقدم المشاهدة' }, { status: 500 })
  }
}
