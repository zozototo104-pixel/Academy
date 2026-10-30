import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// فهارس المسارات الساخنة (تدقيق ٢٠٢٦-١٠-٣٠، الوحدة ٩): ستة جداول مركزية
// كانت بلا أي فهرس ثانوي — كل إشعارات/مالية/طلبات/محاولات عليها مسح كامل.
// العقد هنا مزدوج: إعلان الفهرس في المخطط + إنشاؤه فعلياً في الهجرة بنفس
// الاسم والأعمدة — هجرة مكتوبة يدوياً بلا هذا التطابق ستنحرف بصمت.
// ---------------------------------------------------------------------------

const root = join(import.meta.dir, '..', '..')
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(
  join(root, 'prisma/migrations/20261030200000_add_hot_path_indexes/migration.sql'),
  'utf8',
)

const EXPECTED: Array<{ model: string; columns: string[] }> = [
  { model: 'Notification', columns: ['userId', 'read', 'createdAt'] },
  { model: 'Payment', columns: ['userId', 'status'] },
  { model: 'Payment', columns: ['status'] },
  { model: 'ExamAttempt', columns: ['userId', 'examId', 'status'] },
  { model: 'ProgramExamAttempt', columns: ['userId', 'examId', 'status'] },
  { model: 'AdmissionApplication', columns: ['status', 'createdAt'] },
  { model: 'AdmissionApplication', columns: ['supervisorId'] },
  { model: 'AdmissionApplication', columns: ['userId'] },
  { model: 'AuditLog', columns: ['createdAt'] },
  { model: 'AuditLog', columns: ['entity', 'entityId'] },
]

function modelBlock(model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))
  if (!match) throw new Error(`model ${model} not found in schema`)
  return match[1]
}

describe('فهارس المسارات الساخنة', () => {
  test('القائمة المتفق عليها كاملة: ١٠ فهارس', () => {
    expect(EXPECTED.length).toBe(10)
  })

  for (const { model, columns } of EXPECTED) {
    test(`${model}(${columns.join(', ')}) معلن في المخطط ومنشأ في الهجرة بنفس الاسم`, () => {
      const schemaLine = `@@index([${columns.join(', ')}])`
      expect(modelBlock(model)).toContain(schemaLine)

      const indexName = `${model}_${columns.join('_')}_idx`
      const columnList = columns.map((c) => `"${c}"`).join(', ')
      expect(migration).toContain(`CREATE INDEX "${indexName}" ON "${model}"(${columnList});`)
    })
  }

  test('الهجرة إضافة فقط: لا حذف ولا تعديل بيانات', () => {
    expect(migration).not.toMatch(/DROP\s/i)
    expect(migration).not.toMatch(/ALTER\s+TABLE/i)
    expect(migration).not.toMatch(/UPDATE\s|DELETE\s+FROM/i)
    const creates = migration.match(/CREATE INDEX/g) || []
    expect(creates.length).toBe(10)
  })
})
