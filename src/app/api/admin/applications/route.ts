import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { nextCertSerial, nextContractNo, nextInvoiceNo, getSettings } from '@/lib/settings'
import { randomBytes } from 'crypto'

const ACC_TYPE_LABEL: Record<string, string> = {
  COMPANY: 'اعتماد هيئة تدريبية (شركة/مؤسسة/مركز)',
  CONSULTANT: 'اعتماد مستشار دولي',
  TRAINER: 'اعتماد مدرب دولي معتمد',
  QUALITY: 'اعتماد الجودة',
}

// GET /api/admin/applications — قائمة طلبات الوكالة والاعتماد
export async function GET() {
  try {
    await requireAdmin()
    const applications = await db.agentApplication.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
        revenueShares: { orderBy: { createdAt: 'desc' }, take: 20 },
        certificates: { orderBy: { issuedAt: 'desc' } },
        documents: { select: { id: true, docType: true, fileName: true, size: true, mimeType: true } },
      },
    })
    // فواتير رسوم تقديم الاعتماد المرتبطة (ACCREDITATION_FEE)
    const agentIds = applications.map((a) => a.id)
    const fees = agentIds.length
      ? await db.payment.findMany({
          where: { agentId: { in: agentIds }, purpose: 'ACCREDITATION_FEE' },
          select: { agentId: true, invoiceNo: true, amount: true, status: true },
        })
      : []
    return NextResponse.json({
      applications: applications.map((a) => ({
        ...a,
        applicationFee: fees.find((f) => f.agentId === a.id) || null,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل الطلبات' }, { status: 500 })
  }
}

// PATCH /api/admin/applications — تحديث حالة الطلب
// عند القبول: وكالة → إنشاء عقد سنة بعمولة 25% | اعتماد → إصدار شهادة اعتماد رقمية + فاتورة
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id, status, exclusive, revokedReason, revocationAcknowledged } = await req.json()
    if (!id || !['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'].includes(status)) {
      return NextResponse.json({ error: 'بيانات غير صحيحة' }, { status: 400 })
    }
    const app = await db.agentApplication.findUnique({
      where: { id },
      include: { certificates: true }, // ضروري لحارس التكرار وتعطيل شهادة الاعتماد عند السحب
    })
    if (!app) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 })

    const data: any = { status }
    let contractNo: string | null = null
    let certSerial: string | null = null
    let revokedCertificates = 0

    if (status === 'REVOKED') {
      if (app.status !== 'APPROVED') {
        return NextResponse.json({ error: 'لا يمكن سحب الاعتماد إلا من طلب مقبول/معتمد فعلياً' }, { status: 400 })
      }
      const reason = String(revokedReason || '').replace(/\s+/g, ' ').trim()
      if (reason.length < 25) {
        return NextResponse.json({ error: 'سبب إلغاء الاعتماد مطلوب ويجب أن يكون واضحاً ومفصلاً' }, { status: 400 })
      }
      if (!revocationAcknowledged) {
        return NextResponse.json({ error: 'يجب تأكيد أن الإلغاء مبني على مخالفة عقدية/مهنية موثقة وأن القرار قابل للمراجعة إدارياً' }, { status: 400 })
      }
      data.revokedAt = new Date()
      data.revokedReason = reason.slice(0, 1200)
      data.revokedById = admin.id
      revokedCertificates = await db.certificate.updateMany({
        where: { agentId: app.id, valid: true },
        data: { valid: false },
      }).then((r) => r.count)
    }

    if (status === 'APPROVED' && !app.contractNo && !app.certificates?.length) {
      if (app.kind === 'AGENCY') {
        // وفق عقد التمثيل والتفويض الدولي: مدة سنة قابلة للتجديد + عمولة 25%
        const settings = await getSettings()
        const start = new Date()
        const end = new Date(start)
        end.setFullYear(end.getFullYear() + 1)
        contractNo = await nextContractNo()
        data.contractNo = contractNo
        data.commissionRate = parseFloat(settings.AGENT_COMMISSION_RATE || '25')
        data.committeeFee = parseFloat(settings.COMMITTEE_MEMBER_FEE || '100')
        data.exclusive = exclusive ?? true
        data.startDate = start
        data.endDate = end
      } else {
        // قاعدة رسمية: لا اعتماد قبل سداد رسوم تقديم الاعتماد (100$)
        const feePaid = await db.payment.findFirst({
          where: { agentId: app.id, purpose: 'ACCREDITATION_FEE', status: 'PAID' },
        })
        if (!feePaid) {
          return NextResponse.json(
            { error: 'لا يمكن إصدار الاعتماد قبل سداد صاحب الطلب رسوم التقديم (100$) — راجع تبويب «طلبات الاعتماد» للحالة' },
            { status: 400 }
          )
        }
        // اعتماد: شهادة اعتماد رقمية + فاتورة رسوم الاعتماد حسب الفئة
        const settings = await getSettings()
        const feeMap: Record<string, string> = {
          COMPANY: settings.FEE_ACC_COMPANY || '1000',
          CONSULTANT: settings.FEE_ACC_CONSULTANT || '350',
          TRAINER: settings.FEE_ACC_TRAINER || '200',
          QUALITY: '0', // حسب الطلب — تُحدد يدوياً
        }
        const amount = parseFloat(feeMap[app.accreditationType || ''] || '0')
        certSerial = await nextCertSerial()
        await db.certificate.create({
          data: {
            serial: certSerial,
            qrToken: randomBytes(16).toString('hex'),
            type: 'ACCREDITATION',
            holderName: app.orgName,
            program: ACC_TYPE_LABEL[app.accreditationType || ''] || 'اعتماد دولي',
            country: app.country,
            agentId: app.id,
          },
        })
        if (amount > 0) {
          const owner = await db.user.findUnique({ where: { email: app.email }, select: { id: true } })
          await db.payment.create({
            data: {
              agentId: app.id,
              userId: owner?.id || null,
              invoiceNo: await nextInvoiceNo(),
              purpose: 'ACCREDITATION',
              description: `رسوم ${ACC_TYPE_LABEL[app.accreditationType || '']} — ${app.orgName}`,
              amount,
              payerName: app.repName,
              payerEmail: app.email,
              payerCountry: app.country,
            },
          })
        }
      }
    }

    const updated = await db.agentApplication.update({ where: { id }, data })

    // إشعار صاحب الطلب إن كان مستخدماً مسجلاً بنفس البريد
    const owner = await db.user.findUnique({ where: { email: app.email } })
    if (owner) {
      if (status === 'APPROVED') {
        await notify(
          owner.id,
          'AGENT',
          app.kind === 'AGENCY' ? 'تم اعتماد وكالتك الدولية' : 'تم إصدار شهادة اعتمادك',
          app.kind === 'AGENCY'
            ? `تم اعتماد وكالتك بنطاق ${app.territory || app.country}. رقم العقد ${contractNo} — العمولة 25% ومستحقات اللجان 100$ لكل بحث. راجع بوابة الوكيل.`
            : `تم إصدار شهادة الاعتماد رقم ${certSerial} باسم ${app.orgName}. راجع تبويب بوابتك أو صفحة التحقق.`,
          'agent'
        )
      } else if (status === 'REJECTED') {
        await notify(owner.id, 'AGENT', 'نتيجة طلبك', `نأسف — لم يُعتمد طلب ${app.kind === 'AGENCY' ? 'الوكالة' : 'الاعتماد'} المقدم باسم ${app.orgName}.`)
      } else if (status === 'REVOKED') {
        await notify(
          owner.id,
          'AGENT',
          app.kind === 'AGENCY' ? 'تم إلغاء الوكالة الدولية' : 'تم سحب الاعتماد',
          `تم إلغاء ${app.kind === 'AGENCY' ? 'الوكالة' : 'الاعتماد'} باسم ${app.orgName} وفق مراجعة إدارية بسبب: ${String(revokedReason || '').slice(0, 260)}. يمكنكم التواصل مع الإدارة لطلب مراجعة القرار.`,
          'agent'
        )
      }
    }

    const auditAction = status === 'APPROVED' ? 'APPROVE_AGENT' : status === 'REVOKED' ? 'REVOKE_AGENT_ACCREDITATION' : 'REJECT_AGENT'
    const auditDetails = status === 'REVOKED'
      ? `${app.orgName} — سحب اعتماد/وكالة — سبب: ${String(revokedReason || '').slice(0, 500)} — شهادات معطلة: ${revokedCertificates}`
      : `${app.orgName} — ${app.kind === 'AGENCY' ? `عقد ${contractNo}` : `شهادة ${certSerial}`}`
    await audit(admin, auditAction, 'AgentApplication', id, auditDetails)

    return NextResponse.json({ ok: true, application: updated, contractNo, certSerial, revokedCertificates })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin applications PATCH error:', e)
    return NextResponse.json({ error: 'خطأ في التحديث' }, { status: 500 })
  }
}
