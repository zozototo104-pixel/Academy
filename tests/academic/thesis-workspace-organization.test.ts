import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminExtras.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')
const thesisStart = source.indexOf('export function AdminThesisTab()')
const financeMarker = '// ============ المالية: المدفوعات + التقارير ============'
const financeStart = source.indexOf(financeMarker)
const thesisBlock = source.slice(thesisStart, financeStart)
const financeAndAfter = source.slice(financeStart)

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

describe('AdminThesisTab workspace organization', () => {
  test('keeps AdminThesisTab bounded before the finance section', () => {
    expect(thesisStart).toBeGreaterThan(-1)
    expect(financeStart).toBeGreaterThan(thesisStart)
    expect(financeAndAfter.includes('expandedThesisId')).toBe(false)
    expect(financeAndAfter.includes('thesis-details-')).toBe(false)
  })

  test('keeps TSX parseable through the public TypeScript API', () => {
    const result = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
      fileName: sourcePath,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('adds exactly one thesis detail selection state and no index-based selection', () => {
    required(thesisBlock, "const [expandedThesisId, setExpandedThesisId] = useState<string | null>(null)")
    expect(occurrences(thesisBlock, 'expandedThesisId')).toBeGreaterThanOrEqual(5)
    expect(thesisBlock.includes('key={index}')).toBe(false)
    expect(thesisBlock.includes('expandedThesisIndex')).toBe(false)
  })

  test('renders compact thesis cards with an accessible expand control', () => {
    required(thesisBlock, 'عرض تفاصيل البحث')
    required(thesisBlock, 'إغلاق التفاصيل')
    required(thesisBlock, 'type="button"')
    required(thesisBlock, 'aria-expanded={isExpanded}')
    required(thesisBlock, 'aria-controls={detailsPanelId}')
    required(thesisBlock, 'const detailsPanelId = `thesis-details-${t.id}`')
    required(thesisBlock, 'onClick={() => setExpandedThesisId(isExpanded ? null : t.id)}')
  })

  test('prevents stale details from reappearing after filtering, paging, or refresh', () => {
    required(thesisBlock, 'if (!expandedThesisId) return')
    required(thesisBlock, 'if (pagedTheses.some((t) => t.id === expandedThesisId)) return')
    required(thesisBlock, 'setExpandedThesisId(null)')
    required(thesisBlock, '[expandedThesisId, pagedTheses]')
  })

  test('keeps the existing local search, filter, and paging contracts', () => {
    required(thesisBlock, 'matchesAdminSearch(thesisSearch')
    required(thesisBlock, 'pageItems(filteredTheses, thesisPage, thesisPageSize)')
    required(thesisBlock, 'safePage(filteredTheses.length, thesisPageSize, thesisPage)')
    required(thesisBlock, "const active = !['RESULT_APPROVED'].includes(t.status)")
    required(thesisBlock, "api<{ theses: Thesis[] }>('/api/admin/thesis')")
    expect(thesisBlock.includes('/api/admin/thesis?')).toBe(false)
  })

  test('keeps all academic statuses and decision actions', () => {
    for (const status of [
      'PLAN_SUBMITTED',
      'PLAN_NEEDS_REVISION',
      'PLAN_APPROVED',
      'FINAL_NEEDS_REVISION',
      'SUBMITTED',
      'SCHEDULED',
      'RESULT_APPROVED',
      'NEEDS_REVISION',
    ]) required(thesisBlock, status)

    for (const action of [
      'APPROVE_PLAN',
      'REQUEST_PLAN_REVISION',
      'REQUEST_FINAL_REVISION',
      'SCHEDULE',
      'RESULT',
      'REPROCESS',
    ]) required(thesisBlock, action)
  })

  test('keeps sensitive thesis operations in their existing functions', () => {
    for (const fn of ['const load = () =>', 'const schedule = async () =>', 'const reprocessThesis = async', 'const thesisAction = async', 'const recordResult = async']) {
      required(thesisBlock, fn)
    }
    required(thesisBlock, 'committee: JSON.stringify(members.split')
    required(thesisBlock, 'agentMember,')
    required(thesisBlock, "action: 'RESULT'")
    required(thesisBlock, "action: 'REPROCESS'")
    required(thesisBlock, 'setRoomThesis(t)')
    required(thesisBlock, 'setShowRecording(t)')
    required(thesisBlock, 'setMinutesThesis(t)')
  })

  test('keeps dialogs and heavy media outside the compact card flow', () => {
    const pagerIndex = thesisBlock.indexOf('<AdminPager')
    const scheduleDialogIndex = thesisBlock.indexOf('{/* نافذة الجدولة */}')
    const roomDialogIndex = thesisBlock.indexOf('{/* 12.3: نافذة قاعة المناقشة')
    const videoTagIndex = thesisBlock.indexOf('<video')
    expect(scheduleDialogIndex).toBeGreaterThan(pagerIndex)
    expect(roomDialogIndex).toBeGreaterThan(pagerIndex)
    expect(videoTagIndex).toBeGreaterThan(pagerIndex)
    required(thesisBlock, '<DefenseRoom')
    required(thesisBlock, 'onFinished={load}')
  })

  test('keeps thesis dialogs and draft states protected', () => {
    for (const stateName of [
      'sched',
      'resulting',
      'roomThesis',
      'minutesThesis',
      'showRecording',
      'date',
      'members',
      'agentMember',
      'score',
      'passed',
      'busy',
      'actionDialog',
    ]) required(thesisBlock, stateName)
  })

  test('adds loaded-data summary without pretending to show academy-wide totals', () => {
    required(thesisBlock, 'ضمن الأبحاث المحمّلة')
    required(thesisBlock, 'loadedActiveCount')
    required(thesisBlock, 'loadedScheduledCount')
    required(thesisBlock, 'loadedApprovedResultsCount')
    required(thesisBlock, '{pagedTheses.length} ظاهرة في الصفحة الحالية')
  })

  test('guards against broken JSX template literal leakage', () => {
    expect(thesisBlock.includes('>${')).toBe(false)
    expect(thesisBlock.includes('>$')).toBe(false)
  })
})
