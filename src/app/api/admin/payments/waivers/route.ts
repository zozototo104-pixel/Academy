import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ActivePaymentWaiverExistsError, approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType, resendPaymentWaiverCode } from '@/lib/payment-waivers'
import { audit } from '@/lib/notify'

function cleanText(value: unknown, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

class WaiverCancelUnsafeError extends Error {
  status = 409
  code = 'WAIVER_CANCEL_UNSAFE'

  constructor() {
    super('تعذّر إلغاء هذا الإعفاء تلقائياً لأن تفعيل الطالب لم يعد قائماً على هذا الإعفاء وحده (توجد مبالغ مسددة فعلياً، أو إعفاء آخر مستقل، أو نشاط أكاديمي بدأ). راجع التحاق الطالب وعالج الإلغاء يدوياً من شاشة القبول والتسجيل ثم أعد المحاولة.')
  }
}

// عكس تفعيل الإعفاء عند إلغاء كود معتمد: اعتماد الإعفاء قد فعّل التحاق
// الطالب (حالة القبول + التحاق ACTIVE) عبر finalizeAdmissionAfterSettlement،
// فإعادة الفاتورة وحدها إلى UNPAID تترك المال والوصول على خلاف. نخطط العكس
// داخل نفس معاملة الإلغاء، ولا ننفذه إلا إذا كان آمناً بالكامل:
//  - لا فاتورة شقيقة مسددة فعلياً (PAID) لنفس القبول — التفعيل ليس من هذا
//    الإعفاء وحده.
//  - كل فاتورة شقيقة معفاة (WAIVED) صنعها هذا الإعفاء نفسه (نفس النوع والسبب
//    والمعتمِد: مسح المنحة الكاملة أو رصيد فاتورة التقديم) — إعفاء شقيق
//    مستقل يعني رفضاً.
//  - القبول لم يتجاوز مرحلتي التفعيل (THESIS/SUPERVISOR_ASSIGNED).
//  - لا بصمة أكاديمية: لا وحدات مكتملة، لا محاولات امتحانات، لا فصل مغلق
//    أو نتيجة معتمدة، لا طلب تخرج، لا درجة نهائية/شهادة، والتحاق غير مكتمل.
// عندها: الفواتير الشقيقة تُستعاد كما تُستعاد فاتورة الكود، والقبول يعود
// إلى AWAITING_TUITION، والالتحاق النشط يعود إلى PENDING_PAYMENT (حالته
// قبل التفعيل في مسار التسجيل المباشر). لقطة القواعد وحالات الفصول التي
// أنشأها التفعيل تبقى كما هي: إنشاؤها عند أي تفعيل لاحق محروس بـ
// create-once فلا تتكرر ولا تتعارض.
async function planWaiverCancelReversal(tx: any, waiver: any) {
  const plan: { siblings: any[]; admissionData: Record<string, any> | null; enrollmentUpdate: { id: string; data: Record<string, any> } | null } = {
    siblings: [],
    admissionData: null,
    enrollmentUpdate: null,
  }
  const admissionId = waiver.payment.admissionId
  const app = await tx.admissionApplication.findUnique({ where: { id: admissionId } })
  if (!app) return plan

  const payments = await tx.payment.findMany({ where: { admissionId } })
  const others = payments.filter((p: any) => p.id !== waiver.paymentId)
  if (others.some((p: any) => p.status === 'PAID')) throw new WaiverCancelUnsafeError()
  for (const p of others) {
    if (p.status !== 'WAIVED') continue
    const byThisWaiver = p.waiverType === waiver.waiverType
      && p.waiverReason === waiver.reason
      && (p.waiverApprovedById || null) === (waiver.approvedById || null)
    if (!byThisWaiver) throw new WaiverCancelUnsafeError()
    plan.siblings.push(p)
  }

  const appStatus = String(app.status || '')
  if (['SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(appStatus)) throw new WaiverCancelUnsafeError()

  const userId = app.userId || waiver.payment.userId || null
  if (app.programId && userId) {
    const enrollment = await tx.enrollment.findUnique({ where: { userId_programId: { userId, programId: app.programId } } })
    if (enrollment) {
      let completedUnits: unknown[] = []
      try {
        const parsed = JSON.parse(enrollment.completedUnits || '[]')
        if (Array.isArray(parsed)) completedUnits = parsed
      } catch { /* قيمة غير صالحة تُعامل كقائمة فارغة */ }
      const attempts = (await tx.examAttempt.count({ where: { userId } })) + (await tx.programExamAttempt.count({ where: { userId } }))
      const semesterProgress = await tx.enrollmentSemesterState.findFirst({
        where: { enrollmentId: enrollment.id, OR: [{ status: 'CLOSED' }, { result: { not: null } }, { approvedScore: { not: null } }] },
      })
      const graduation = await tx.graduationRequest.findUnique({ where: { enrollmentId: enrollment.id } })
      if (
        enrollment.status === 'COMPLETED'
        || completedUnits.length > 0
        || enrollment.finalScore != null
        || !!enrollment.certificateNo
        || attempts > 0
        || !!semesterProgress
        || !!graduation
      ) {
        throw new WaiverCancelUnsafeError()
      }
      if (enrollment.status === 'ACTIVE') {
        plan.enrollmentUpdate = { id: enrollment.id, data: { status: 'PENDING_PAYMENT' } }
      }
    }
  }

  const admissionData: Record<string, any> = {}
  if (['THESIS', 'SUPERVISOR_ASSIGNED'].includes(appStatus)) admissionData.status = 'AWAITING_TUITION'
  if (waiver.waiverType === 'FULL_SCHOLARSHIP') admissionData.scholarshipFull = false
  plan.admissionData = Object.keys(admissionData).length ? admissionData : null
  return plan
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const paymentId = cleanText(body.paymentId, 80)
    const waiverType = cleanText(body.waiverType, 40)
    const reason = cleanText(body.reason)
    const requestedAmount = body.requestedAmount === undefined || body.requestedAmount === null || body.requestedAmount === '' ? null : Number(body.requestedAmount)
    if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
    if (!isPaymentWaiverType(waiverType)) return NextResponse.json({ error: 'نوع الإعفاء غير صحيح' }, { status: 400 })
    const result = await createPaymentWaiverCode({
      paymentId,
      waiverType,
      reason,
      requestedAmount,
      actor: { id: admin.id, name: admin.name || admin.email || 'Admin' },
      expiresDays: Number(body.expiresDays || 7),
    })
    return NextResponse.json({ code: result.code, waiver: result.waiver, emailStatus: result.emailStatus })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    if (e instanceof ActivePaymentWaiverExistsError || e?.code === 'ACTIVE_WAIVER_EXISTS') {
      return NextResponse.json({ error: e.message, code: 'ACTIVE_WAIVER_EXISTS' }, { status: 409 })
    }
    // لا تعكس نص الخطأ الداخلي (Prisma/قاعدة بيانات) إلى المتصل: رسالة
    // عامة للواجهة، والخطأ الحقيقي كاملاً في سجل الخادم فقط.
    console.error('payment waiver code creation failed:', e)
    return NextResponse.json({ error: 'تعذر توليد كود الإعفاء' }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = cleanText(body.action, 40).toUpperCase()
    if (action === 'RESEND') {
      const paymentId = cleanText(body.paymentId, 80)
      if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
      const result = await resendPaymentWaiverCode({ paymentId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      return NextResponse.json({ code: result.code, waiver: result.waiver, emailStatus: result.emailStatus, whatsapp: result.whatsapp })
    }
    const waiverId = cleanText(body.waiverId, 80)
    if (!waiverId) return NextResponse.json({ error: 'معرّف كود الإعفاء مطلوب' }, { status: 400 })

    if (action === 'APPROVE') {
      const payment = await approvePaymentWaiver({ waiverId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      return NextResponse.json({ payment })
    }

    if (action === 'REJECT' || action === 'CANCEL') {
      const status = action === 'REJECT' ? 'REJECTED' : 'CANCELLED'
      const waiver = await db.paymentWaiverCode.findUnique({ where: { id: waiverId }, include: { payment: true } })
      if (!waiver) return NextResponse.json({ error: 'كود الإعفاء غير موجود' }, { status: 404 })
      if (action === 'REJECT' && waiver.status === 'APPROVED') {
        return NextResponse.json({ error: 'لا يمكن رفض إعفاء معتمد. استخدم إلغاء الإعفاء لإعادة الفاتورة لحالتها.' }, { status: 400 })
      }
      let result: any
      try {
        result = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${waiver.paymentId} FOR UPDATE`
          // إلغاء كود معتمد مرتبط بقبول: خطط عكس التفعيل أولاً — إن لم يكن
          // آمناً تُرفض العملية كلها (409) قبل أي كتابة.
          const reversal = action === 'CANCEL' && waiver.status === 'APPROVED' && waiver.payment.admissionId
            ? await planWaiverCancelReversal(tx, waiver)
            : null
          const updatedWaiver = await tx.paymentWaiverCode.update({ where: { id: waiverId }, data: { status } })
          let updatedPayment: any = null
          if (action === 'CANCEL' && waiver.status === 'APPROVED') {
            const originalCents = Math.max(Number(waiver.payment.originalAmountCents || 0), Number(waiver.payment.amountCents || 0) + Number(waiver.payment.waivedAmountCents || 0))
            const originalAmount = originalCents > 0 ? originalCents / 100 : Number(waiver.payment.originalAmount || waiver.payment.amount || 0)
            updatedPayment = await tx.payment.update({
              where: { id: waiver.paymentId },
              data: {
                status: 'UNPAID',
                amount: originalAmount,
                amountCents: Math.round(originalAmount * 100),
                waivedAmount: 0,
                waivedAmountCents: 0,
                waiverStatus: 'CANCELLED',
                waiverReason: waiver.payment.waiverReason ? `${waiver.payment.waiverReason} — تم إلغاء الإعفاء المعتمد` : 'تم إلغاء الإعفاء المعتمد',
                waiverApprovedById: null,
                waiverApprovedAt: null,
                paidAt: null,
                method: null,
                receiptNo: null,
              },
            })
            if (reversal) {
              for (const sibling of reversal.siblings) {
                const siblingOriginalCents = Math.max(Number(sibling.originalAmountCents || 0), Number(sibling.amountCents || 0) + Number(sibling.waivedAmountCents || 0))
                const siblingOriginalAmount = siblingOriginalCents > 0 ? siblingOriginalCents / 100 : Number(sibling.originalAmount || sibling.amount || 0)
                await tx.payment.update({
                  where: { id: sibling.id },
                  data: {
                    status: 'UNPAID',
                    amount: siblingOriginalAmount,
                    amountCents: Math.round(siblingOriginalAmount * 100),
                    waivedAmount: 0,
                    waivedAmountCents: 0,
                    waiverStatus: 'CANCELLED',
                    waiverReason: sibling.waiverReason ? `${sibling.waiverReason} — تم إلغاء الإعفاء المعتمد` : 'تم إلغاء الإعفاء المعتمد',
                    waiverApprovedById: null,
                    waiverApprovedAt: null,
                    paidAt: null,
                    method: null,
                    receiptNo: null,
                  },
                })
              }
              if (reversal.admissionData) {
                await tx.admissionApplication.update({ where: { id: waiver.payment.admissionId }, data: reversal.admissionData })
              }
              if (reversal.enrollmentUpdate) {
                await tx.enrollment.update({ where: { id: reversal.enrollmentUpdate.id }, data: reversal.enrollmentUpdate.data })
              }
            } else if (waiver.waiverType === 'FULL_SCHOLARSHIP' && waiver.payment.admissionId) {
              await tx.admissionApplication.update({ where: { id: waiver.payment.admissionId }, data: { scholarshipFull: false } }).catch(() => null)
            }
          } else {
            updatedPayment = await tx.payment.updateMany({ where: { id: waiver.paymentId, waiverStatus: { in: ['REQUESTED', 'VERIFIED'] } }, data: { waiverStatus: status } })
          }
          return { waiver: updatedWaiver, payment: updatedPayment }
        })
      } catch (e: any) {
        if (e instanceof WaiverCancelUnsafeError || e?.code === 'WAIVER_CANCEL_UNSAFE') {
          return NextResponse.json({ error: e.message, code: 'WAIVER_CANCEL_UNSAFE' }, { status: 409 })
        }
        throw e
      }
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' }, `PAYMENT_WAIVER_${status}`, 'Payment', waiver.paymentId, `${waiver.codePreview} — ${waiver.waiverType}${waiver.status === 'APPROVED' ? ' — إعادة الفاتورة إلى UNPAID' : ''}`)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الإعفاء' }, { status: 400 })
  }
}
