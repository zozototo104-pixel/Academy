import { db } from '../src/lib/db'
import { ACADEMY_INFO, ADMISSION_GUIDE, ACCREDITATION_GUIDE } from '../src/lib/academyData'

const defaults: Record<string, string> = {
  ACADEMY_NAME_AR: ACADEMY_INFO.nameAr,
  ACADEMY_NAME_EN: ACADEMY_INFO.nameEn,
  ACADEMY_FOUNDED: String(ACADEMY_INFO.founded || ''),
  ACADEMY_TAGLINE_AR: ACADEMY_INFO.taglineAr,
  ACADEMY_TAGLINE_EN: ACADEMY_INFO.taglineEn,
  ACADEMY_PROGRAMS_TEXT: ACADEMY_INFO.programs,
  ADMISSION_CONDITIONS_TEXT: ADMISSION_GUIDE.conditions.join(' / '),
  ADMISSION_DOCUMENTS_TEXT: ADMISSION_GUIDE.documents.join(' / '),
  ADMISSION_STEPS_TEXT: ADMISSION_GUIDE.steps.join(' ← '),
  ADMISSION_GRADUATION_TEXT: ADMISSION_GUIDE.graduation.join(' / '),
  ADMISSION_NOTE_TEXT: ADMISSION_GUIDE.note,
  ACCREDITATION_BENEFITS_TEXT: ACCREDITATION_GUIDE.benefits.join(' / '),
}

function isProductionDeployment() {
  return process.env.VERCEL_ENV === 'production'
}

function isDatabaseUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code || '') : ''
  return code === 'P1001' || message.includes("Can't reach database server") || message.includes('PrismaClientInitializationError')
}

function canSkipUnavailableDatabase() {
  return !isProductionDeployment() && process.env.MIGRATE_OFFICIAL_AI_SETTINGS_REQUIRED !== 'true'
}

async function main() {
  let created = 0
  for (const [key, value] of Object.entries(defaults)) {
    const existing = await db.setting.findUnique({ where: { key }, select: { key: true } })
    if (existing) continue
    await db.setting.create({ data: { key, value } })
    created += 1
  }
  console.log(JSON.stringify({ ok: true, created, checked: Object.keys(defaults).length }, null, 2))
}

main().catch((error) => {
  if (isDatabaseUnavailableError(error) && canSkipUnavailableDatabase()) {
    console.warn(JSON.stringify({ ok: true, skipped: true, reason: 'DATABASE_UNAVAILABLE', checked: Object.keys(defaults).length }, null, 2))
    return
  }
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await db.$disconnect().catch(() => {})
})
