import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { allSeedPrograms } from '@/lib/academyData'
import { DEFAULT_SETTINGS } from '@/lib/settings'
import { degreeSpecializationSeedPrograms, GENERIC_ALL_SPECIALIZATIONS_SLUGS } from '@/lib/program-tracks'

let inflight: Promise<void> | null = null
let lastCheckedAt = 0

async function seedProgramsIfEmpty(): Promise<void> {
  const count = await db.program.count().catch(() => 0)
  if (count > 0) return

  console.log('🌱 Runtime bootstrap: programs table is empty, seeding default programs...')

  for (const p of allSeedPrograms) {
    const program = await db.program.upsert({
      where: { slug: p.slug },
      update: {
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        description: p.description,
        category: p.category,
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.stringify(p.features),
        order: p.order,
        active: true,
      },
      create: {
        slug: p.slug,
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        description: p.description,
        category: p.category,
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.stringify(p.features),
        order: p.order,
        active: true,
      },
    })

    for (const u of p.units) {
      const existing = await db.unit.findFirst({ where: { programId: program.id, order: u.order } })
      const unitData = {
        programId: program.id,
        order: u.order,
        title: u.title,
        summary: u.summary,
        content: JSON.stringify(u.content),
        objectives: JSON.stringify(u.objectives),
      }
      const unit = existing
        ? await db.unit.update({ where: { id: existing.id }, data: unitData })
        : await db.unit.create({ data: unitData })

      const existingExam = await db.exam.findUnique({ where: { unitId: unit.id } })
      const examData = { unitId: unit.id, title: u.exam.title, passScore: u.exam.passScore }
      const exam = existingExam
        ? await db.exam.update({ where: { id: existingExam.id }, data: examData })
        : await db.exam.create({ data: examData })

      await db.question.deleteMany({ where: { examId: exam.id } })
      for (let i = 0; i < u.exam.questions.length; i++) {
        const q = u.exam.questions[i]
        await db.question.create({
          data: {
            examId: exam.id,
            order: i + 1,
            type: q.type,
            text: q.text,
            options: q.options ? JSON.stringify(q.options) : null,
            correctAnswer: q.correctAnswer,
            modelAnswer: q.modelAnswer,
            points: q.points,
          },
        })
      }
    }
  }

  console.log(`✅ Runtime bootstrap: seeded ${allSeedPrograms.length} programs`)
}

async function seedAdminIfMissing(): Promise<void> {
  const adminEmail = 'admin@aact.academy'
  const admin = await db.user.findUnique({ where: { email: adminEmail } }).catch(() => null)
  const password = hashPassword('Admin@2026')

  if (!admin) {
    await db.user.create({
      data: {
        email: adminEmail,
        password,
        name: 'إدارة الأكاديمية',
        role: 'ADMIN',
        country: 'USA',
      },
    })
    console.log('✅ Runtime bootstrap: default admin created')
    return
  }

  if (admin.role !== 'ADMIN') {
    await db.user.update({ where: { email: adminEmail }, data: { role: 'ADMIN' } })
  }
}

async function seedSettingsIfEmpty(): Promise<void> {
  for (const s of DEFAULT_SETTINGS) {
    await db.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value },
      update: {},
    }).catch(() => {})
  }
}

export async function ensureCoreSeed(force = false): Promise<void> {
  if (!force && Date.now() - lastCheckedAt < 60_000) return
  if (inflight) return inflight

  inflight = (async () => {
    try {
      await seedProgramsIfEmpty()
      await seedAdminIfMissing()
      await seedSettingsIfEmpty()
      lastCheckedAt = Date.now()
    } catch (e) {
      console.error('Runtime bootstrap failed:', e)
      throw e
    } finally {
      inflight = null
    }
  })()

  return inflight
}
