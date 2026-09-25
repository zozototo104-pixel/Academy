import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { markInvoicePaid } from '@/lib/settle-payment'
import { notify, audit } from '@/lib/notify'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'

// GET /api/admin/payments — كل الفواتير والمستحقات (للإدارة)
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const status = cleanAdminQuery(sp.get('status'))
    const method = cleanAdminQuery(sp.get('method'))

    const knownStatuses = new Set(['PAID', 'UNPAID'])
    const knownPurposes = new Set(['APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT', 'ACCREDITATION_APP', 'ACCREDITATION_FEE', 'ACCREDITATION', 'SERVICE_FEE', 'AI_LIVE_CREDIT', 'OTHER'])
    const manualPendingWhere = {
      status: 'UNPAID',
      OR: [
        { method: { in: ['DIRECT_PAYMENT', 'USDT'] } },
        { provider: { in: ['DIRECT_PAYMENT', 'USDT'] } },
      ],
    }

    const andFilters: any[] = []
    if (status && status !== 'ALL') {
      if (status === 'MANUAL_PENDING') andFilters.push(manualPendingWhere)
      else if (knownStatuses.has(status)) andFilters.push({ status })
      else if (knownPurposes.has(status)) andFilters.push({ purpose: status })
      else andFilters.push({ status })
    }
    if (method && method !== 'ALL') andFilters.push({ OR: [{ method }, { provider: method }] })
    if (search) {
      andFilters.push({
        OR: [
          { invoiceNo: { contains: search, mode: 'insensitive' } },
          { receiptNo: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { payerName: { contains: search, mode: 'insensitive' } },
          { payerEmail: { contains: search, mode: 'insensitive' } },
          { cryptoTxHash: { contains: search, mode: 'insensitive' } },
          { admission: { reference: { contains: search, mode: 'insensitive' } } },
          { admission: { fullName: { contains: search, mode: 'insensitive' } } },
          { admission: { program: { contains: search, mode: 'insensitive' } } },
        ],
      })
    }
    const where: any = andFilters.length ? { AND: andFilters } : {}

    const [payments, total, paidCount, paidSum, unpaidSum] = await Promise.all([
      db.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          admission: { select: { reference: true, fullName: true, country: true, program: true } },
        },
      }),
      db.payment.count({ where }),
      db.payment.count({ where: { ...where, status: 'PAID' } }),
      db.payment.aggregate({ where: { ...where, status: 'PAID' }, _sum: { amount: true } }),
      db.payment.aggregate({ where: { ...where, status: 'UNPAID' }, _sum: { amount: true } }),
    ])
    const totals = {
      collected: paidSum._sum.amount || 0,
      pending: unpaidSum._sum.amount || 0,
      count: total,
      paidCount,
    }
    return NextResponse.json({ payments, totals, total, pagination: adminPaginationMeta(page, pageSize, total) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المدفوعات' }, { status: 500 })
  }
}

// PATCH /api/admin/payments — تأكيد دفعة يدوية (تحويل بنكي/واتساب)
// يستخدم markInvoicePaid كي تُطبَّق كل آثار السداد رسمياً: الإيصال + تحويل حالة الطلب + تفعيل التسجيل + البريد
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id } = await req.json()
    const payment = await db.payment.findUnique({ where: { id } })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') return NextResponse.json({ ok: true, payment })
    if (payment.method === 'USDT') {
      const hasTx = !!payment.cryptoTxHash
      const canManualReview = hasTx && payment.cryptoVerificationStatus === 'UNSUPPORTED'
      if (payment.cryptoVerificationStatus !== 'VERIFIED' && !canManualReview) {
        return NextResponse.json({ error: 'لا يمكن تأكيد دفع USDT قبل إدخال TX Hash والتحقق الأولي منه. الشبكات غير المدعومة آلياً يمكن اعتمادها يدوياً بعد وجود TxID واضح.' }, { status: 400 })
      }
    }

    const confirmMethod = payment.method === 'DIRECT_PAYMENT' ? 'DIRECT_PAYMENT' : payment.method === 'USDT' ? 'USDT' : 'BANK_TRANSFER'
    const r = await markInvoicePaid(payment.invoiceNo, confirmMethod, {
      actor: { id: admin.id, name: admin.name },
    })
    if (!r.ok) return NextResponse.json({ error: r.error || 'تعذر تأكيد السداد' }, { status: 400 })

    await audit(admin, 'CONFIRM_PAYMENT', 'Payment', id, `${r.receiptNo} — ${payment.description} (${payment.amount}$) [تأكيد إداري يدوي]`)
    return NextResponse.json({ ok: true, payment: r.payment, receiptNo: r.receiptNo })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التأكيد' }, { status: 500 })
  }
}
