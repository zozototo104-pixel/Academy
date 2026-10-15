import { PrismaClient } from '@prisma/client'

const DATABASE_URL_CANDIDATES = [
  'DATABASE_URL',
  'DATABASE_POSTGRES_PRISMA_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_POSTGRES_URL',
  'POSTGRES_URL',
  'DATABASE_POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NON_POOLING',
  'DATABASE_SUPABASE_URL',
  'SUPABASE_URL',
]

if (!process.env.DATABASE_URL) {
  const fallback = DATABASE_URL_CANDIDATES.map((key) => process.env[key]).find((value) => value && /^postgres(ql)?:\/\//i.test(value.trim()))
  if (fallback) process.env.DATABASE_URL = fallback.trim()
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  paymentWaiverMiddlewareInstalled?: boolean
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query', 'error', 'warn'],
  })

if (!globalForPrisma.paymentWaiverMiddlewareInstalled) {
  globalForPrisma.paymentWaiverMiddlewareInstalled = true
  db.$use(async (params, next) => {
    if (params.model === 'Payment' && params.action === 'create') {
      const data = params.args?.data
      const purpose = String(data?.purpose || '').toUpperCase()
      const admissionId = data?.admissionId
      if (admissionId && ['TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) {
        const app = await db.admissionApplication.findUnique({ where: { id: admissionId }, select: { scholarshipFull: true } }).catch(() => null)
        if (app?.scholarshipFull) {
          const amountCents = Number(data?.amountCents ?? Math.round((Number(data?.amount || 0) || 0) * 100))
          data.status = 'WAIVED'
          data.waiverType = data.waiverType || 'FULL_SCHOLARSHIP'
          data.waiverStatus = data.waiverStatus || 'APPROVED'
          data.waiverReason = data.waiverReason || 'منحة كاملة معتمدة مسبقاً لهذا الطلب'
          data.originalAmountCents = data.originalAmountCents ?? amountCents
          data.originalAmount = data.originalAmount ?? Number(data?.amount || 0)
          data.waivedAmountCents = data.waivedAmountCents ?? amountCents
          data.waivedAmount = data.waivedAmount ?? Number(data?.amount || 0)
          data.amountCents = 0
          data.amount = 0
          data.waiverApprovedAt = data.waiverApprovedAt || new Date()
        }
      }
    }
    return next(params)
  })
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db