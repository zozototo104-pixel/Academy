import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/password'

const prisma = new PrismaClient()

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function main() {
  const email = required('AACT_ADMIN_EMAIL').toLowerCase()
  const password = required('AACT_ADMIN_PASSWORD')
  const name = process.env.AACT_ADMIN_NAME?.trim() || 'إدارة الأكاديمية'

  if (password.length < 12) {
    throw new Error('AACT_ADMIN_PASSWORD must be at least 12 characters long.')
  }

  if (process.env.NODE_ENV === 'production' && process.env.AACT_CREATE_ADMIN !== 'YES') {
    throw new Error('Refusing to create/update admin in production. Set AACT_CREATE_ADMIN=YES for this one-time operation.')
  }

  const existing = await prisma.user.findUnique({ where: { email } })
  const data = {
    email,
    name,
    role: 'ADMIN' as const,
    country: existing?.country || 'USA',
    password: hashPassword(password),
  }

  if (existing) {
    await prisma.user.update({ where: { email }, data: { password: data.password, role: 'ADMIN', name } })
    console.log(`Admin updated: ${email}`)
  } else {
    await prisma.user.create({ data })
    console.log(`Admin created: ${email}`)
  }
}

main()
  .catch((e) => {
    console.error('Create admin error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
