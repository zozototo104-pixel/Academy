import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

const ACC_TYPE_LABEL: Record<string, string> = {
  COMPANY: 'اعتماد هيئة تدريبية (شركة/مؤسسة/مركز)',
  CONSULTANT: 'اعتماد مستشار دولي',
  TRAINER: 'اعتماد مدرب دولي معتمد',
  QUALITY: 'اعتماد الجودة',
}

export const dynamic = 'force-dynamic'

// GET /api/admin/agents/preview?agentId=xxx
// معاينة إدارية للوكالة/الاعتماد — قراءة فقط، لا تمثل دخولاً كصاحب الطلب ولا تسمح بتقديم طلب بدلاً عنه.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const agentId = req.nextUrl.searchParams.get('agentId')?.trim()
    if (!agentId) return NextResponse.json({ error: 'معرف طلب الوكالة/الاعتماد مطلوب' }, { status: 400 })

    const app = await db.agentApplication.findUnique({
      where: { id: agentId },
      include: {
        user: { select: { id: true, name: true, email: true, role: true, country: true, phone: true, createdAt: true } },
        documents: { select: { id: true, docType: true, fileName: true, mimeType: true, size: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        payments: { select: { id: true, invoiceNo: true, purpose: true, description: true, amount: true, currency: true, method: true, status: true, receiptNo: true, paidAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        certificates: { select: { id: true, serial: true, type: true, holderName: true, program: true, grade: true, valid: true, issuedAt: true }, orderBy: { issuedAt: 'desc' } },
        revenueShares: { select: { id: true, type: true, description: true, amount: true, currency: true, status: true, dueDate: true, paidAt: true, programCountry: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    if (!app) return NextResponse.json({ error: 'طلب الوكالة/الاعتماد غير موجود' }, { status: 404 })

    const submitterByEmail = app.user || await db.user.findUnique({
      where: { email: app.email },
      select: { id: true, name: true, email: true, role: true, country: true, phone: true, createdAt: true },
    }).catch(() => null)
    const submittedByStaff = !!submitterByEmail && ['ADMIN', 'SUPERVISOR'].includes(submitterByEmail.role)
    const paidTotal = app.payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const unpaidTotal = app.payments.filter((p) => p.status !== 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const dueRevenue = app.revenueShares.filter((r) => r.status === 'DUE').reduce((sum, r) => sum + Number(r.amount || 0), 0)
    const paidRevenue = app.revenueShares.filter((r) => r.status === 'PAID').reduce((sum, r) => sum + Number(r.amount || 0), 0)

    return NextResponse.json({
      previewMode: 'ADMIN_READ_ONLY',
      note: 'هذه معاينة إدارية للمتابعة فقط؛ لا تعني دخولاً كصاحب الطلب ولا تسمح بتقديم الطلب أو دفع الرسوم نيابة عنه من حساب الإدارة.',
      application: {
        ...app,
        user: submitterByEmail,
        submittedByStaff,
        accreditationLabel: app.kind === 'ACCREDITATION' ? (ACC_TYPE_LABEL[app.accreditationType || ''] || 'اعتماد') : 'وكالة دولية',
      },
      overview: {
        documents: app.documents.length,
        certificates: app.certificates.length,
        validCertificates: app.certificates.filter((c) => c.valid).length,
        payments: app.payments.length,
        paidTotal,
        unpaidTotal,
        revenueRows: app.revenueShares.length,
        dueRevenue,
        paidRevenue,
        submittedByStaff,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin agent preview error:', e)
    return NextResponse.json({ error: 'تعذر تحميل معاينة الوكالة/الاعتماد' }, { status: 500 })
  }
}
