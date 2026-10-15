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
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query', 'error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db