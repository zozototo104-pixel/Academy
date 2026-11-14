import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// AI health-check results display (Haris, 2026-11-14 19:00, production):
// pressing any check button ran the check (toast: "checked 16") but the
// screen kept showing the old persisted health log (first 40 rows, all
// providers) — the check's own per-model results were returned by the
// route and thrown away by the tab. "تحديث صحة النماذج" reloaded the
// same stale log, so it visibly gave nothing. The fix: the tab keeps
// the last check's results and renders them as "نتائج آخر فحص" right
// under the model picker; refresh clears them and reloads the saved
// per-provider snapshot (with a toast, so it visibly answers).
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const count = (src: string, needle: string) => src.split(needle).length - 1

describe('ai health-check results display', () => {
  test('tab keeps the last check results with label, time and rows', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(tab).toContain('type HealthCheckResultRow = { provider: string; model: string; ok: boolean; latencyMs?: number; error?: string }')
    expect(tab).toContain("const [lastHealthCheck, setLastHealthCheck] = useState<{ label: string; at: string; results: HealthCheckResultRow[] } | null>(null)")
  })

  test('all three check handlers store the returned results', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(count(tab, 'setLastHealthCheck({')).toBe(3)
    expect(count(tab, 'results: result.results || []')).toBe(3)
    expect(count(tab, 'results: Array<HealthCheckResultRow>')).toBe(3)
    expect(tab).toContain("label: `فحص النموذج المحدد — ${catalogProviderForModels}/${model}`")
    expect(tab).toContain("label: `فحص كل نماذج المزود — ${catalogProviderForModels}`")
    expect(tab).toContain("label: 'فحص الكل'")
  })

  test('results section renders what was just checked, not the old log', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(tab).toContain('نتائج آخر فحص — {lastHealthCheck.label}')
    expect(tab).toContain('lastHealthCheck.results.slice(0, 100).map((item) => (')
    expect(tab).toContain("{item.provider}/{item.model} — {item.ok ? 'يعمل' : 'فشل'}")
    expect(tab).toContain("String(item.error || '').slice(0, 120)")
    expect(tab).toContain('لم يُفحص أي نموذج في هذه المحاولة.')
    expect(tab).toContain('يعرض أول 100 من {lastHealthCheck.results.length} نموذجاً.')
  })

  test('refresh clears the last check and visibly answers', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(tab).toContain('const refreshTextModelHealthNow = () => {')
    expect(count(tab, 'setLastHealthCheck(null)')).toBe(2)
    expect(tab).toContain('loadTextModelHealth({ notify: true })')
    expect(tab).toContain('onClick={refreshTextModelHealthNow}')
    expect(tab).not.toContain('onClick={loadTextModelHealth}')
    expect(tab).toContain("const loadTextModelHealth = (opts?: { notify?: boolean }) => {")
    expect(tab).toContain("toast({ title: 'تم تحديث صحة النماذج'")
    expect(tab).toContain("toast({ title: 'تعذر تحديث صحة النماذج'")
  })

  test('switching provider clears the last check results', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    const effect = tab.slice(tab.indexOf('useEffect(() => {\n    setTextModelHealth(null)'))
    expect(effect.slice(0, 200)).toContain('setLastHealthCheck(null)')
    expect(effect.slice(0, 200)).toContain('}, [catalogProviderForModels])')
  })

  test('persisted health list stays the restored first-40 global log', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(tab).toContain('textModelHealth.health.slice(0, 40).map((item) => (')
    expect(tab).not.toContain('.filter((item) => item.provider === catalogProviderForModels)')
  })

  test('server returns per-model results for all three check actions', () => {
    const lib = read('src/lib/text-ai.ts')
    expect(lib).toContain('results: Array<{ provider: string; model: string; ok: boolean; latencyMs?: number; error?: string }>')
    const route = read('src/app/api/admin/system/route.ts')
    expect(route).toContain("return NextResponse.json({ ok: true, ...(await textAiCheckAllModelHealth({ maxMs: 40_000 })) })")
    expect(route).toContain("return NextResponse.json({ ok: true, ...(await textAiCheckAllModelHealth({ maxMs: 35_000, provider, model })) })")
    expect(route).toContain('const result = await textAiCheckAllModelHealth({ maxMs: 110_000, provider, models })')
    expect(route).toContain('return NextResponse.json({ ok: true, total: models.length, source, complete: result.checked === new Set(models).size, ...result })')
  })
})
