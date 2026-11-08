import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { decideReopenAppeal } from '@/lib/reopen-appeals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إدارة التماسات إعادة الفتح (المرحلة 4): قائمة + بتّ. البتّ مشروط
// بالحالة داخل المكتبة — قراران متزامنان ينجح أحدهما فقط.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const status = req.nextUrl.searchParams.get('status') || undefined
    const appeals = await (db as any).reopenAppeal.findMany({
      where: { ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    // أسماء وعناوين للعرض في قائمة البتّ — دفعة واحدة ودفاعيًا.
    try {
      // Treat the dynamic appeal store as untrusted input: Prisma's
      // StringFilter.in requires string[], never unknown[].
      const userIds = [...new Set<string>((appeals as Array<{ userId?: unknown }>)
        .map((a) => a.userId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
      const programIds = [...new Set<string>((appeals as Array<{ programId?: unknown }>)
        .map((a) => a.programId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
      const unitIds = [...new Set<string>((appeals as Array<{ unitId?: unknown }>)
        .map((a) => a.unitId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
      const [users, programs, units]: [any[], any[], any[]] = await Promise.all([
        userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
        programIds.length ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true, titleEn: true } }) : [],
        unitIds.length ? db.unit.findMany({ where: { id: { in: unitIds as string[] } }, select: { id: true, title: true } }) : [],
      ])
      const userById = new Map(users.map((u) => [u.id, u]))
      const programById = new Map(programs.map((p) => [p.id, p]))
      const unitById = new Map(units.map((u) => [u.id, u]))
      for (const a of appeals as any[]) {
        a.studentName = userById.get(a.userId)?.name || null
        a.studentEmail = userById.get(a.userId)?.email || null
        a.programTitle = programById.get(a.programId)?.titleAr || programById.get(a.programId)?.titleEn || null
        a.unitTitle = a.unitId ? unitById.get(a.unitId)?.title || null : null
      }
    } catch { /* الأسماء تجميلية — القائمة تعمل بدونها */ }
    return NextResponse.json({ ok: true, appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تحميل الالتماسات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const result = await decideReopenAppeal(db, {
      appealId: String(body?.appealId || ''),
      actor: { id: admin.id },
      approve: body?.approve === true,
      note: body?.note ? String(body.note) : null,
    })
    if (!result.ok) {
      const status = result.code === 'FORBIDDEN' ? 403 : result.code === 'APPEAL_NOT_FOUND' ? 404 : result.code === 'APPEAL_ALREADY_DECIDED' ? 409 : 400
      const messages: Record<string, string> = {
        FORBIDDEN: 'صلاحية إدارية مطلوبة للبتّ في الالتماسات.',
        APPEAL_NOT_FOUND: 'الالتماس غير موجود.',
        APPEAL_ALREADY_DECIDED: 'حُسم هذا الالتماس من جلسة أخرى.',
        INVALID_INPUT: 'بيانات البتّ ناقصة.',
      }
      return NextResponse.json({ error: messages[result.code] || 'تعذر البتّ في الالتماس', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, appeal: result.appeal })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin reopen-appeal decide error:', e)
    return NextResponse.json({ error: 'تعذر البتّ في الالتماس' }, { status: 500 })
  }
}
