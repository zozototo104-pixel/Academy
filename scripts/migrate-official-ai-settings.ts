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
  console.error(error)
  process.exit(1)
}).finally(async () => db.$disconnect())
