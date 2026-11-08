import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { assignMercyActivity, gradeMercyActivity, requestMercy } from '@/lib/mercy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إدارة الاسترحام (المرحلة 4): قائمة الطلبات + بدء مباشر موثّق +
// إسناد نشاط + تصحيحه. إعادة مصادقة نتيجة الفصل تتم من شاشة الشروط
// بمسار الاعتماد نفسه بعد التصحيح.
export async function GET() {
  try {
    await requireAdmin()
    const requests = await (db as any).mercyRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }).catch(() => [])
    // أسماء وعناوين للعرض في قائمة الإدارة — دفعة واحدة ودفاعيًا.
    let enriched = requests as any[]
    try {
      const userIds = [...new Set<string>((requests as Array<{ userId?: unknown }>)
        .map((r) => r.userId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
      const programIds = [...new Set<string>((requests as Array<{ programId?: unknown }>)
        .map((r) => r.programId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
      const [users, programs]: [any[], any[]] = await Promise.all([
        userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
        programIds.length ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true, titleEn: true } }) : [],
      ])
      const userById = new Map(users.map((u) => [u.id, u]))
      const programById = new Map(programs.map((p) => [p.id, p]))
      enriched = (requests as any[]).map((r) => ({
        ...r,
        studentName: userById.get(r.userId)?.name || null,
        studentEmail: userById.get(r.userId)?.email || null,
        programTitle: programById.get(r.programId)?.titleAr || programById.get(r.programId)?.titleEn || null,
      }))
    } catch { /* الأسماء تجميلية — القائمة تعمل بدونها */ }
    return NextResponse.json({ ok: true, requests: enriched })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')
    let result: any
    if (action === 'start') {
      result = await requestMercy(db, {
        userId: String(body?.userId || ''),
        programId: String(body?.programId || ''),
        semester: Number(body?.semester),
        initiatedBy: 'ADMIN',
      })
    } else if (action === 'assign') {
      result = await assignMercyActivity(db, {
        mercyId: String(body?.mercyId || ''),
        actor: { id: admin.id },
        title: String(body?.title || ''),
        instructions: body?.instructions ? String(body.instructions) : null,
        weightPercent: Number(body?.weightPercent),
        dueAt: body?.dueAt ? String(body.dueAt) : null,
      })
    } else if (action === 'grade') {
      result = await gradeMercyActivity(db, {
        mercyId: String(body?.mercyId || ''),
        actor: { id: admin.id },
        score: Number(body?.score),
      })
    } else {
      return NextResponse.json({ error: 'إجراء غير معروف', code: 'INVALID_INPUT' }, { status: 400 })
    }
    if (!result.ok) {
      const messages: Record<string, string> = {
        SEMESTER_NOT_FAILED: 'الاسترحام يبدأ فقط لفصل مغلق بنتيجة راسب معتمدة.',
        SEMESTER_EXAM_NOT_TAKEN: 'لا يمكن بدء الاسترحام لطالب لم يقدّم الامتحان الفصلي فعليًا، حتى لو اعتُمد الفصل راسبًا.',
        MERCY_ALREADY_EXISTS: 'سبق أن استُخدم مسار الاسترحام لهذا الفصل.',
        MERCY_DEADLINE_TOO_LONG: 'مهلة النشاط لا تتجاوز 7 أيام تقويمية من الإسناد.',
        MERCY_WEIGHT_INVALID: 'وزن النشاط بين 1 و50 بالمئة من معدل الفصل.',
        MERCY_WRONG_STATE: 'حالة الطلب لا تسمح بهذا الإجراء الآن.',
        MERCY_NOT_FOUND: 'الطلب غير موجود.',
        FORBIDDEN: 'لا صلاحية لهذا الإجراء.',
        ENROLLMENT_NOT_FOUND: 'لا تسجيل مطابقًا.',
        INVALID_INPUT: 'بيانات ناقصة أو غير صالحة.',
      }
      const status = result.code === 'MERCY_NOT_FOUND' || result.code === 'ENROLLMENT_NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 409
      return NextResponse.json({ error: messages[result.code] || 'تعذر تنفيذ الإجراء', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, mercy: result.mercy })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin mercy POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}
