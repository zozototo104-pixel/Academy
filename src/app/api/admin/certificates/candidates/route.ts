import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { cleanAdminQuery } from '@/lib/admin-query'
import { evaluateProgramCertificateEligibility } from '@/lib/certificate-eligibility'
import { inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'

function paymentSummary(payments: Array<{ purpose: string; status: string; amount: number; amountCents?: number | null; waiverType?: string | null; waivedAmount?: number | null; waivedAmountCents?: number | null; originalAmount?: number | null; originalAmountCents?: number | null }>) {
  const nonTuitionUnpaid = payments.filter((p) => !['TUITION', 'TUITION_INSTALLMENT'].includes(p.purpose) && !['PAID', 'WAIVED'].includes(p.status))
  const tuitionTotal = roundMoney(inferTotalTuition(payments))
  const tuitionPaid = roundMoney(tuitionPaidTotal(payments))
  const tuitionOk = tuitionTotal <= 0 || tuitionPaid >= tuitionTotal
  const missing: string[] = []
  if (nonTuitionUnpaid.length > 0) missing.push('فواتير غير دراسية غير مسددة')
  if (!tuitionOk) missing.push(`رسوم دراسية غير مكتملة: المسدد ${tuitionPaid}$ من ${tuitionTotal}$`)
  return { tuitionTotal, tuitionPaid, tuitionOk, nonTuitionUnpaid: nonTuitionUnpaid.length, missing }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const search = cleanAdminQuery(sp.get('search'))
    const limit = Math.min(Math.max(Number(sp.get('limit') || 80), 10), 150)
    const where: any = {
      status: { notIn: ['CERTIFIED', 'REJECTED'] },
      userId: { not: null },
      programId: { not: null },
      certificates: { none: {} },
      programRef: { is: { category: { not: 'SERVICE' } } },
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { reference: { contains: search, mode: 'insensitive' } },
                  { fullName: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                  { program: { contains: search, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    }

    const apps = await db.admissionApplication.findMany({
      where,
      take: limit,
      orderBy: [{ createdAt: 'desc' }],
      include: {
        payments: true,
        programRef: { select: { id: true, titleAr: true, titleEn: true, category: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    })

    const candidates = await Promise.all(apps.map(async (app) => {
      const eligibility = await evaluateProgramCertificateEligibility({ userId: app.userId, programId: app.programId, admissionId: app.id })
      const payments = paymentSummary(app.payments.map((p) => ({ purpose: p.purpose, status: p.status, amount: p.amount, amountCents: p.amountCents, waivedAmount: p.waivedAmount, waivedAmountCents: p.waivedAmountCents, originalAmount: p.originalAmount, originalAmountCents: p.originalAmountCents })))
      const missing = [...payments.missing, ...(eligibility.ok ? [] : (eligibility.missing.length ? eligibility.missing : [eligibility.error || 'شروط النجاح الأكاديمي غير مكتملة']))]
      const ready = eligibility.ok && payments.tuitionOk && payments.nonTuitionUnpaid === 0
      return {
        id: app.id,
        reference: app.reference,
        fullName: app.fullName,
        email: app.email,
        country: app.country || '',
        program: app.program,
        status: app.status,
        userId: app.userId,
        programId: app.programId,
        programCategory: app.programRef?.category || '',
        ready,
        missing,
        eligibility: {
          ok: eligibility.ok,
          score: eligibility.score,
          gradeLabel: eligibility.gradeLabel,
          error: eligibility.error || '',
          components: eligibility.components,
        },
        payments,
        createdAt: app.createdAt,
      }
    }))

    const ready = candidates.filter((c) => c.ready)
    const blocked = candidates.filter((c) => !c.ready)
    return NextResponse.json({ ready, blocked, total: candidates.length, counts: { ready: ready.length, blocked: blocked.length } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('certificate candidates error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مرشحي الشهادات' }, { status: 500 })
  }
}
