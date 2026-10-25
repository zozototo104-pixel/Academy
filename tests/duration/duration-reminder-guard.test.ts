import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('duration + reminder guard', () => {
  test('schema: per-program max days, extension days, extension requests', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).toContain('maxStudyDays')
    expect(schema).toContain('extensionDays')
    expect(schema).toContain('model ProgramExtensionRequest')
    expect(schema).toContain('lastReminderAt')
    expect(existsSync(join(root, 'prisma/migrations/20261025140000_program_duration/migration.sql'))).toBe(true)
  })
  test('thesis settings are untouched by this package', () => {
    const settings = read('src/lib/settings.ts')
    expect(settings).toContain('THESIS_MIN_MONTHS')
    expect(settings).toContain('THESIS_MAX_MONTHS')
    const durationLib = read('src/lib/program-duration.ts')
    expect(durationLib).not.toContain('THESIS')
  })
  test('daily cron exists and is registered', () => {
    expect(existsSync(join(root, 'src/app/api/cron/student-reminders/route.ts'))).toBe(true)
    expect(read('vercel.json')).toContain('/api/cron/student-reminders')
    expect(read('src/app/api/cron/student-reminders/route.ts')).toContain('processDailyReminders')
  })
  test('reminder channels are platform + email only — never WhatsApp', () => {
    const lib = read('src/lib/student-reminders.ts')
    expect(lib.toLowerCase()).not.toContain('whatsapp')
    expect(lib).toContain('sendEmail')
    expect(lib).toContain('notify(')
  })
  test('close path uses EXPIRED and the platform final-grade formula', () => {
    const lib = read('src/lib/student-reminders.ts')
    expect(lib).toContain("status: 'EXPIRED'")
    expect(lib).toContain('calculateFinalGrade')
    expect(lib).not.toContain('CERTIFIED')
  })
  test('study schedule is sequential by semester and dashboard groups by semester', () => {
    expect(read('src/app/api/study-schedule/route.ts')).toContain('semesterBaseOffsets')
    const dashboard = read('src/components/aact/DashboardView.tsx')
    expect(dashboard).toContain('`${item.semester}:${item.week}`')
    expect(dashboard).toContain('الفصل {week.semester} — الأسبوع {week.week}')
  })
  test('reminder banner is red, pulsing, with the voice button next to it', () => {
    const banner = read('src/components/aact/StudentReminderBanner.tsx')
    expect(banner).toContain('border-red-500')
    expect(banner).toContain('animate-ping')
    expect(banner).toContain('استمع للتذكير')
    expect(banner).toContain('/api/ai/tts')
    expect(read('src/components/aact/DashboardView.tsx')).toContain('StudentReminderBanner')
  })
  test('admin rules panel has the per-program max-days field', () => {
    const rules = read('src/components/aact/AdminRulesTab.tsx')
    expect(rules).toContain('المدة القصوى للدراسة (بالأيام)')
    expect(rules).toContain('maxStudyDays')
    expect(read('src/app/api/admin/program-rules/route.ts')).toContain('maxStudyDays')
  })
  test('extension request + decision APIs exist', () => {
    expect(existsSync(join(root, 'src/app/api/student/extension-requests/route.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/app/api/admin/extension-requests/route.ts'))).toBe(true)
    expect(read('src/app/api/student/extension-requests/route.ts')).toContain('PENDING')
    expect(read('src/app/api/admin/extension-requests/route.ts')).toContain('EXPIRED')
  })
})
