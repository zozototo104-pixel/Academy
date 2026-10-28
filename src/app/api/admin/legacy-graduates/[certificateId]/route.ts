import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { deleteStoredFile } from '@/lib/storage'

type RouteContext = { params: Promise<{ certificateId: string }> | { certificateId: string } }

export const runtime = 'nodejs'

// DELETE /api/admin/legacy-graduates/[certificateId]
// حذف خريج سابق كاملاً، بقاعدة أمان محافظة:
// - الشهادة نفسها تُحذف دائمًا (مع ملفاتها المخزّنة: الأصل والمختوم).
// - التسجيل المرتبط يُحذف فقط إذا لم تبقَ عليه شهادات أخرى.
// - حساب المستخدم يُحذف فقط إذا لم يبقَ له أي تسجيل أو شهادة أو دفعة
//   أو جلسة أو إشعار — أي الحساب الذي انعمل مع هذه الشهادة فقط.
//   إذا كان الحساب قديمًا ومرتبطًا بأشياء أخرى، يبقى الحساب وتُحذف
//   الشهادة (والتسجيل الفارغ) فقط، وتُعاد النتيجة ليعرف الأدمن ما حُذف.
// - الشهادات غير القديمة (legacy=false) مرفوضة هنا نهائيًا: هذا المسار
//   لخريجي التبويب القديم فقط، ولا يمسّ شهادات البرامج الحقيقية.
// ترتيب الحذف مهم: علاقات الشهادة Restrict، فالشهادة أولاً ثم التسجيل
// ثم المستخدم، وكل ذلك داخل معاملة واحدة.
export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin()
    const { certificateId } = await context.params
    if (!certificateId) return NextResponse.json({ error: 'معرّف الشهادة مطلوب' }, { status: 400 })

    const cert = await db.certificate.findUnique({ where: { id: certificateId } })
    if (!cert || !cert.legacy) {
      return NextResponse.json({ error: 'شهادة الخريج السابق غير موجودة' }, { status: 404 })
    }

    const removed = await db.$transaction(async (tx) => {
      await tx.certificate.delete({ where: { id: cert.id } })

      let enrollmentDeleted = false
      if (cert.enrollmentId) {
        const remainingCerts = await tx.certificate.count({ where: { enrollmentId: cert.enrollmentId } })
        if (remainingCerts === 0) {
          await tx.enrollment.delete({ where: { id: cert.enrollmentId } })
          enrollmentDeleted = true
        }
      }

      let userDeleted = false
      if (cert.userId) {
        const [enrollments, certificates, payments, sessions, notifications] = await Promise.all([
          tx.enrollment.count({ where: { userId: cert.userId } }),
          tx.certificate.count({ where: { userId: cert.userId } }),
          tx.payment.count({ where: { userId: cert.userId } }),
          tx.session.count({ where: { userId: cert.userId } }),
          tx.notification.count({ where: { userId: cert.userId } }),
        ])
        if (enrollments === 0 && certificates === 0 && payments === 0 && sessions === 0 && notifications === 0) {
          await tx.user.delete({ where: { id: cert.userId } })
          userDeleted = true
        }
      }

      const removedParts = ['الشهادة']
      if (enrollmentDeleted) removedParts.push('التسجيل')
      if (userDeleted) removedParts.push('حساب المستخدم')
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          actorName: admin.name || 'Admin',
          action: 'DELETE_LEGACY_GRADUATE',
          entity: 'Certificate',
          entityId: cert.id,
          details: `${cert.serial} — ${cert.holderName} — حُذف: ${removedParts.join(' + ')}`,
        },
      })
      return { enrollment: enrollmentDeleted, user: userDeleted }
    })

    // ملفات الختم بعد حذف السجل: أفضل جهد، فشلها لا يبطل الحذف
    // (الملف اليتيم لا يضرّ، بينما فشل قاعدة البيانات كان سيبقي الشهادة).
    for (const key of [cert.uploadedFileKey, cert.stampedFileKey]) {
      if (key) {
        try {
          await deleteStoredFile(key)
        } catch {
          // تجاهل: الحذف الأساسي تمّ.
        }
      }
    }

    return NextResponse.json({ ok: true, deleted: { certificate: true, ...removed } })
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403) {
      return NextResponse.json({ error: 'غير مصرح' }, { status: error.status })
    }
    return NextResponse.json({ error: 'تعذر حذف الخريج السابق' }, { status: 500 })
  }
}
