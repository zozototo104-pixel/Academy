import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards for the 2026-10-25-a package: assignment deadline is a fixed
// calendar date chosen by the admin (never days, never AI-suggested), and
// lecture videos gain title/description editing plus admin-only deletion.

const root = join(import.meta.dir, '../..')
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
const adminBooks = readFileSync(join(root, 'src/components/aact/AdminBooks.tsx'), 'utf8')
const dashboard = readFileSync(join(root, 'src/components/aact/DashboardView.tsx'), 'utf8')
const suggestRoute = readFileSync(join(root, 'src/app/api/admin/assignments/suggest/route.ts'), 'utf8')
const adminAssignmentsRoute = readFileSync(join(root, 'src/app/api/admin/assignments/route.ts'), 'utf8')
const videoRoute = readFileSync(join(root, 'src/app/api/admin/lectures/videos/[id]/route.ts'), 'utf8')
const storage = readFileSync(join(root, 'src/lib/storage.ts'), 'utf8')
const adminLectures = readFileSync(join(root, 'src/components/aact/AdminLectures.tsx'), 'utf8')
const migrationDirs = readdirSync(join(root, 'prisma/migrations'))
const migrationSql = migrationDirs
  .filter((d) => d.includes('assignment_due_at'))
  .map((d) => readFileSync(join(root, 'prisma/migrations', d, 'migration.sql'), 'utf8'))
  .join('\n')

describe('assignment fixed-date guards', () => {
  test('schema and migration carry dueAt on ProgramAssignment', () => {
    expect(schema).toContain('dueAt')
    expect(migrationSql).toContain('ADD COLUMN "dueAt"')
  })
  test('admin form offers a calendar date, not a days duration', () => {
    expect(adminBooks).toContain('آخر موعد تسليم الواجب')
    expect(adminBooks).toContain('type="date"')
    expect(adminBooks).not.toContain('مدة التسليم بالأيام')
  })
  test('student label is a real deadline, never "مقترح"', () => {
    expect(dashboard).not.toContain('آخر موعد مقترح')
    expect(dashboard).toContain('آخر موعد:')
  })
  test('AI suggestions never set a deadline', () => {
    expect(suggestRoute).toContain('dueDays: null')
    expect(suggestRoute).not.toContain('asInt(item?.dueDays')
    expect(adminAssignmentsRoute).toContain('dueAt:')
  })
})

describe('lecture video edit/delete guards', () => {
  test('video route has an admin-only DELETE with storage cleanup', () => {
    expect(videoRoute).toContain('export async function DELETE')
    expect(videoRoute).toContain('حذف الفيديو صلاحية الأدمن فقط')
    expect(videoRoute).toContain('deleteStoredFile')
    expect(videoRoute).toContain('LECTURE_VIDEO_DELETED')
    expect(storage).toContain('export async function deleteStoredFile')
    expect(storage).toContain("'DELETE'")
  })
  test('admin lectures UI has video edit dialog and admin-only delete button', () => {
    expect(adminLectures).toContain('تعديل فيديو:')
    expect(adminLectures).toContain("surface === 'admin'")
    expect(adminLectures).toContain('سيُحذف سجل تقدم مشاهدته')
  })
})
