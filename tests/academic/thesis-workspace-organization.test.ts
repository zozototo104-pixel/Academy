import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminExtras.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')
const thesisReview = fs.readFileSync(path.join(root, 'src/app/api/supervisor/thesis-review/route.ts'), 'utf8')
const thesisStart = source.indexOf('export function AdminThesisTab()')
const financeMarker = '// ============ المالية: المدفوعات + التقارير ============'
const financeStart = source.indexOf(financeMarker)
const thesisBlock = source.slice(thesisStart, financeStart)
const financeAndAfter = source.slice(financeStart)

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

// ===== بصمات الحماية (AST) — بنفس أسلوب حراس الكتب والجودة =====
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

let thesisFn: ts.FunctionDeclaration | undefined
const helperHashes: Record<string, string> = {}
const visitTop = (node: ts.Node) => {
  if (ts.isFunctionDeclaration(node) && node.name) {
    if (node.name.text === 'AdminThesisTab') thesisFn = node
    if (['safeText', 'parseCommitteeNames', 'formatArabicDate'].includes(node.name.text)) {
      helperHashes[node.name.text] = sha(norm(node.getText(sf)))
    }
  }
  ts.forEachChild(node, visitTop)
}
visitTop(sf)

const frozenHashes: Record<string, string> = {}
const apiCalls: string[] = []
if (thesisFn) {
  const walk = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ['load', 'schedule', 'reprocessThesis', 'thesisAction', 'recordResult'].includes(node.name.text) &&
      node.initializer
    ) {
      frozenHashes[node.name.text] = sha(norm(node.initializer.getText(sf)))
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'api' || node.expression.text === 'fetch')) {
      apiCalls.push(norm(node.getText(sf)))
    }
    ts.forEachChild(node, walk)
  }
  walk(thesisFn)
}

describe('AdminThesisTab workspace organization', () => {
  test('keeps AdminThesisTab bounded before the finance section', () => {
    expect(thesisStart).toBeGreaterThan(-1)
    expect(financeStart).toBeGreaterThan(thesisStart)
    expect(financeAndAfter.includes('expandedThesisId')).toBe(false)
    expect(financeAndAfter.includes('thesis-details-')).toBe(false)
  })

  test('keeps the approved finance-and-after region delegated to its dedicated guards', () => {
    // منطقة المالية وما بعدها تغيّرت بشكل مشروع في مراحل التنظيم اللاحقة.
    // لا نجمد الذيل كله هنا حتى لا يكسر حارس الأبحاث كل تحسين بصري لاحق في AdminExtras.
    // الحماية التفصيلية لهذه المنطقة موجودة في حراس المالية والرسوم والقواعد والشهادات.
    for (const marker of [
      'export function AdminFinanceTab()',
      'export function AdminSettingsTab()',
      'export function AdminCertificatesTab()',
      'toggleFinanceSection',
      'toggleSettingsSection',
    ]) {
      expect(financeAndAfter.includes(marker)).toBe(true)
    }
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

  test('keeps the sensitive operation bodies hash-identical', () => {
    expect(frozenHashes).toEqual({
      load: 'e0b23d1979929ac4fd9bb184ef9d9a4504ef70c274be1f333e18c390a320f884',
      schedule: 'ddf9c3470ce16a3e536095330a7253070405d4ce44b383027e7e3113f57d8d01',
      reprocessThesis: '77a4d2b1e71c9763bc97d3e91f9c4a9d89f7f01eef5751fb0f6e621b87d8bdf9',
      thesisAction: 'f2a48c0cc1498ed3b930de2736cf8d3924618be6c995e2ffbab1a679e02aa19b',
      recordResult: '4d13bacb618c5701c2735ee1f4229c28519fc10a3fc3e8661107c6b2cc59f17f',
    })
  })

  test('keeps the shared helpers hash-identical', () => {
    expect(helperHashes).toEqual({
      safeText: 'a6c953624e21eef8587a0308d07e116a067ee0aeec9cd568892081bd8f9b531d',
      parseCommitteeNames: '27c02ff74d95daaf8a0ca3e359fc69c64b826c1f0715c799e5af9a14487b6d80',
      formatArabicDate: '6a823d97904f292799fadcd28b4a132e4dc5f8a3c8abedb2ad1e96b384fdd910',
    })
  })

  test('keeps the thesis API surface identical (full call expressions)', () => {
    expect(apiCalls.length).toBe(5)
    expect(sha([...apiCalls].sort().join('||'))).toBe('79ed6edf2b865091c447573fec37781fa89c6414501b421a1fbb0e827798f904')
  })

  test('adds exactly one thesis detail selection state and no index-based selection', () => {
    required(thesisBlock, "const [expandedThesisId, setExpandedThesisId] = useState<string | null>(null)")
    // مربوط فعليًا بالعرض والإنهاء، لا مجرد إعلان
    required(thesisBlock, 'const isExpanded = expandedThesisId === t.id')
    required(thesisBlock, 'if (expandedThesisId && !pagedTheses.some((t) => t.id === expandedThesisId))')
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

  test('terminates the selection in-render when the open thesis leaves the current page', () => {
    // النمط المعتمد من مرحلة الكتب: إنهاء مشروط أثناء الرسم — بلا useEffect وبلا تحذير set-state-in-effect
    required(thesisBlock, 'if (expandedThesisId && !pagedTheses.some((t) => t.id === expandedThesisId))')
    required(thesisBlock, 'setExpandedThesisId(null)')
    expect(thesisBlock.includes('}, [expandedThesisId, pagedTheses])')).toBe(false)
  })

  test('labels the four detail groups', () => {
    required(thesisBlock, 'الخطة والملاحظات')
    required(thesisBlock, 'الملف والمعالجة والتحليل')
    required(thesisBlock, 'المناقشة واللجنة')
    required(thesisBlock, 'الإجراءات والقرارات')
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
