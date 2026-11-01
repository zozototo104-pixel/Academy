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

describe('assignment source and grading guardrails', () => {
  const grader = readFileSync(join(root, 'src/lib/supervisor-assignment-grading.ts'), 'utf8')
  const supervisor = readFileSync(join(root, 'src/components/aact/SupervisorView.tsx'), 'utf8')

  test('AI cannot claim a unit while citing knowledge from another unit', () => {
    expect(suggestRoute).toContain('ids.every((id) => unitById.get(id)?.has(candidate))')
    expect(suggestRoute).toContain('matchingUnitIds.includes(requestedUnitId)')
    expect(suggestRoute).toContain('if (!proposedUnitId) continue')
    expect(suggestRoute).toContain('unitId: proposedUnitId')
    expect(suggestRoute).toContain('unitById, id)')
  })

  test('manual and suggested assignments retain validated unit scope', () => {
    expect(adminAssignmentsRoute).toContain('unitId: requestedUnitId')
    expect(adminAssignmentsRoute).toContain('id: requestedUnitId, programId')
    expect(adminAssignmentsRoute).toContain('unitId: a.unitId || null')
    expect(adminBooks).toContain('unitId: s.unitId || null')
    expect(adminBooks).toContain('الوحدة المرجعية للواجب')
  })

  test('legacy unlinked assignments never silently use first unrelated book', () => {
    expect(grader).not.toContain('units.find((u: any) => u.sourceBookId')
    expect(grader).toContain('if (!belongsToProgram) return')
    expect(supervisor).toContain('هذا الواجب لا يملك مرجع وحدة موثوقًا')
  })

  test('missing rubric breakdown is disclosed to both reviewers', () => {
    expect(supervisor).toContain('تعذّر التحقق من تفصيل الدرجة')
    expect(adminBooks).toContain('لم يمكن التحقق من توزيع الدرجة')
  })

  test('JSONB migration and nullable legacy provenance match Prisma', () => {
    const migration = readFileSync(join(root, 'prisma/migrations/20261101080000_assignment_knowledge_sources/migration.sql'), 'utf8')
    expect(schema).toContain('sourceKnowledgeIds Json?')
    expect(migration).toContain('ADD COLUMN "sourceKnowledgeIds" JSONB')
  })

  test('server validates and stores original knowledge IDs against exact unit chunks', () => {
    expect(adminAssignmentsRoute).toContain("id: { in: validatedSourceIds }")
    expect(adminAssignmentsRoute).toContain('sources.length !== validatedSourceIds.length')
    expect(adminAssignmentsRoute).toContain('sourceKnowledgeIds: validatedSourceIds === undefined ? undefined')
    expect(adminAssignmentsRoute).toContain('Prisma.DbNull')
    expect(adminAssignmentsRoute).not.toContain('status: 409')
  })

  test('both UI submission routes retain source IDs and changing unit clears stale evidence', () => {
    expect(adminBooks).toContain('sourceKnowledgeIds: s.sourceKnowledgeIds || null')
    expect(adminBooks).toContain('sourceKnowledgeIds: a.sourceKnowledgeIds || null')
    expect(adminBooks).toContain("unitId: v === 'NONE' ? '' : v, sourceKnowledgeIds: null")
  })

  test('AI grader prioritizes exact source IDs, and reports partial or unit-only fallback', () => {
    expect(grader).toContain('id: { in: sourceIds }')
    expect(grader).toContain('sourceIds.map((id) => originalById.get(id))')
    expect(grader).toContain("status: GradingBookContext['status']")
    expect(grader).toContain("sourceKnowledgeCount: book.expected")
    expect(supervisor).toContain("bookSourceStatus === 'PARTIAL'")
    expect(adminBooks).toContain("bookSourceStatus === 'UNIT'")
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

describe('assignment suggestion hardening guards (PR #168 review fixes)', () => {
  test('suggest route scopes semester-3 sources across taught semesters and pins the requested semester', () => {
    expect(suggestRoute).toContain('semester === 3 ? {} : { semester }')
    expect(suggestRoute).toContain('semester === 3 ? { programId } : { programId, semester }')
    expect(suggestRoute).not.toContain('semester: asInt(item?.semester')
  })
  test('generation is invalidated on program/semester change and checked after every await', () => {
    expect(adminBooks).toContain('assignmentGenerationRef')
    expect(adminBooks).toContain('assignmentAbortRef')
    expect(adminBooks).toContain('invalidateAssignmentGeneration(); setProgramId(v)')
    expect(adminBooks).toContain('invalidateAssignmentGeneration(); setGenSemester(v)')
    expect(adminBooks).toContain('signal: controller.signal')
    expect(adminBooks.split('if (!isCurrent()) return').length - 1).toBeGreaterThanOrEqual(4)
  })
  test('added-marking uses the stable unit+title identity, not the title alone', () => {
    expect(adminBooks).toContain("(x.unitId || '') === (s.unitId || '') && x.title === s.title")
  })
  test('add-all reports per-item results and never announces full success over failures', () => {
    expect(adminBooks).toContain('const failedTitles: string[] = []')
    expect(adminBooks).toContain('if (!failedTitles.length)')
    expect(adminBooks).toContain('اكتملت الإضافة جزئياً')
    expect(adminBooks).not.toContain("if (list.length) toast({ title: 'تمت إضافة الواجبات المقترحة' })")
  })
})
