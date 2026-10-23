import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminAiStageProfiles.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

const functionBody = (name: string) => {
  const marker = `const ${name}`
  const start = source.indexOf(marker)
  expect(start, `Missing function: ${name}`).toBeGreaterThan(-1)
  const firstBrace = source.indexOf('{', start)
  expect(firstBrace, `Missing body for: ${name}`).toBeGreaterThan(start)
  let depth = 0
  for (let i = firstBrace; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`Unclosed function body: ${name}`)
}

const requireAll = (text: string, needles: string[]) => {
  for (const needle of needles) required(text, needle)
}

describe('AdminAiStageProfiles workspace organization', () => {
  test('keeps AdminAiStageProfiles TSX parseable through supported TypeScript API', () => {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('adds one visual workspace state with advisor as the default', () => {
    required(source, "const [openAiProfilesSection, setOpenAiProfilesSection] = useState<'advisor' | 'recheck' | 'profiles'>('advisor')")
  })

  test('renders the three AI profile workspaces without behavior on open', () => {
    required(source, 'aria-label="مساحات عمل بروفايلات الذكاء"')
    for (const text of [
      "['advisor', 'المستشار والتوصيات'",
      "['recheck', 'إعادة تدقيق الأسئلة'",
      "['profiles', 'بروفايلات المراحل'",
    ]) required(source, text)
    required(source, 'type="button"')
    required(source, 'aria-expanded={active}')
    required(source, 'aria-controls={`ai-profiles-section-${value}`}')
    required(source, 'onClick={() => setOpenAiProfilesSection(value)}')
    expect(source.includes('setOpenAiProfilesSection(value); api')).toBe(false)
    expect(source.includes('setOpenAiProfilesSection(value); save')).toBe(false)
    expect(source.includes('setOpenAiProfilesSection(value); load')).toBe(false)
  })

  test('keeps sections mounted and hides only their wrappers', () => {
    for (const [id, hidden] of [
      ['ai-profiles-section-advisor', "hidden={openAiProfilesSection !== 'advisor'}"],
      ['ai-profiles-section-recheck', "hidden={openAiProfilesSection !== 'recheck'}"],
      ['ai-profiles-section-profiles', "hidden={openAiProfilesSection !== 'profiles'}"],
    ]) {
      required(source, `id="${id}"`)
      required(source, hidden)
    }
    expect(source.includes("openAiProfilesSection === 'advisor' &&")).toBe(false)
    expect(source.includes("openAiProfilesSection === 'recheck' &&")).toBe(false)
    expect(source.includes("openAiProfilesSection === 'profiles' &&")).toBe(false)
  })

  test('keeps all AI stages and labels intact', () => {
    for (const stage of ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']) required(source, stage)
    for (const label of ['القراءة', 'التحليل', 'التوليد', 'التدقيق']) required(source, label)
    required(source, "(['READING', 'ANALYSIS', 'GENERATION', 'REVIEW'] as Stage[]).map")
  })

  test('keeps load and initial fetch contracts unchanged', () => {
    requireAll(functionBody('load'), [
      'setLoading(true)',
      "api<ResponseData>('/api/admin/ai-stage-profiles')",
      "api<QuestionRecheckOverview>('/api/admin/question-recheck').catch(() => null)",
      'applyResponse(res)',
      'setQuestionRecheckOverview(recheckOverview)',
      'setLoading(false)',
    ])
    required(source, "api<ResponseData>('/api/admin/ai-stage-profiles')")
    required(source, "api<QuestionRecheckOverview>('/api/admin/question-recheck').catch(() => null)")
  })

  test('keeps stage profile save contract unchanged', () => {
    requireAll(functionBody('save'), [
      'setSavingStage(stage)',
      'const snapshot = formToSnapshot(stage, forms[stage])',
      "api<{ stage: StageData; advisorAdviceId?: string | null; recheckEnqueue?: RecheckEnqueueReport | null }>('/api/admin/ai-stage-profiles', {",
      "method: 'POST'",
      'stage,',
      'snapshot,',
      'advisorAdviceId: advisorDraftToApply.adviceId',
      'enqueueRecheck: { enabled: reviewRecheckEnqueueEnabled, cap: reviewRecheckEnqueueCap }',
      'setLastRecheckEnqueueReport(res.recheckEnqueue)',
      'refreshQuestionRecheckOverview(true)',
      'setSavingStage(null)',
    ])
  })

  test('keeps advisor and question recheck actions unchanged', () => {
    requireAll(functionBody('requestAdvisorAdvice'), [
      'setGeneratingAdvisorAdvice(true)',
      "api<{ created: number; skipped: number; advice: AdvisorAdvice[] }>('/api/admin/ai-advisor', { method: 'POST' })",
      'advisorAdvice: res.advice',
      'setGeneratingAdvisorAdvice(false)',
    ])

    requireAll(functionBody('dismissAdvisorAdvice'), [
      'setDismissingAdvisorAdviceId(id)',
      "await api<{ advice: AdvisorAdvice }>('/api/admin/ai-advisor', {",
      "method: 'PATCH'",
      'body: JSON.stringify({ id })',
      'setDismissingAdvisorAdviceId(null)',
    ])

    requireAll(functionBody('runQuestionRecheck'), [
      'setRunningQuestionRecheck(true)',
      "api<{ batch: RecheckBatchSummary; overview: QuestionRecheckOverview }>('/api/admin/question-recheck', { method: 'POST' })",
      'setLastRecheckBatch(res.batch)',
      'setQuestionRecheckOverview(res.overview)',
      'setRunningQuestionRecheck(false)',
    ])

    requireAll(functionBody('refreshQuestionRecheckOverview'), [
      "api<QuestionRecheckOverview>('/api/admin/question-recheck')",
      'setQuestionRecheckOverview(overview)',
    ])
  })

  test('keeps advisor draft loading and stage form helpers intact', () => {
    requireAll(functionBody('loadAdvisorDraftIntoForm'), [
      'if (!advice.proposedSnapshot) return',
      'snapshotToForm(advice.proposedSnapshot)',
      'targetProfileVersion: advice.targetProfileVersion',
      'snapshotKey: snapshotKey(advice.proposedSnapshot)',
    ])
    required(source, 'function formToSnapshot(stage: Stage, form: FormState): Snapshot')
    required(source, 'function textToRefs(text: string): ModelRef[]')
    required(source, 'function describeSnapshotDiff(before: Snapshot, after: Snapshot, stage: Stage): string[]')
  })

  test('keeps the sensitive review recheck controls visible inside profiles', () => {
    required(source, 'reviewRecheckEnqueueEnabled')
    required(source, 'reviewRecheckEnqueueCap')
    required(source, 'أدخل أسئلة معلّقة إلى طابور إعادة التدقيق بسبب تغيير البروفايل')
    required(source, 'تشغيل دفعة إعادة تدقيق')
    required(source, 'حفظ نسخة جديدة')
  })
})
