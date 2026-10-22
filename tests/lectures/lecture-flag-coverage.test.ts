import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// حراسة شاملة لمفتاح الميزة: كل عملية إدارية للمحاضرات يجب أن تفحص
// isLecturesEnabled() بنفسها، فيكون LECTURES_ENABLED=false مفتاح إيقاف
// كاملًا (404 ولا أي عملية). أي route جديد يُضاف تحت هذا المجلد دون
// الفحص يُسقط هذا الاختبار فورًا.
//
// الاستثناءات: ملفات ليست route.ts لا تُمسح أصلًا. وإن ظهر route لا
// يمثل عملية إدارية فعلية، يُستثنى هنا صراحة بمساره النسبي مع سبب —
// لا يُستثنى بصمت داخل الكود.
const EXEMPT_ROUTE_FILES = new Set<string>([])

const ROOT = 'src/app/api/admin/lectures'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (name === 'route.ts') out.push(path)
  }
  return out
}

function handlerSegments(source: string): { method: string; body: string }[] {
  const parts = source.split(/(?=export async function (?:GET|POST|PATCH|PUT|DELETE)\b)/)
  const segments: { method: string; body: string }[] = []
  for (const part of parts) {
    const m = /^export async function (GET|POST|PATCH|PUT|DELETE)\b/.exec(part)
    if (m) segments.push({ method: m[1], body: part })
  }
  return segments
}

describe('LECTURES_ENABLED kill switch covers every admin lectures operation', () => {
  const files = walk(ROOT).sort()

  test('the sweep finds the admin lectures routes', () => {
    expect(files.length).toBeGreaterThanOrEqual(13)
  })

  for (const file of files) {
    const rel = relative(ROOT, file)
    if (EXEMPT_ROUTE_FILES.has(rel)) continue
    test(`${rel}: every handler checks the flag`, () => {
      const source = readFileSync(file, 'utf8')
      const segments = handlerSegments(source)
      expect(segments.length).toBeGreaterThan(0)
      for (const segment of segments) {
        expect(segment.body).toContain('isLecturesEnabled()')
        expect(segment.body).toContain('status: 404')
        // الفحص يأتي بعد التحقق من الدور وقبل أي عمل قاعدة بيانات.
        const actorAt = segment.body.indexOf('requireLectureManager()')
        const checkAt = segment.body.indexOf('isLecturesEnabled()')
        const dbAt = segment.body.indexOf('db.')
        expect(actorAt).toBeGreaterThan(-1)
        expect(checkAt).toBeGreaterThan(actorAt)
        if (dbAt > -1) expect(checkAt).toBeLessThan(dbAt)
      }
    })
  }
})
