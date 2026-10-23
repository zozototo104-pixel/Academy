import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminSystemTab.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')

const between = (start: string, end: string) => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `Missing start marker: ${start}`).toBeGreaterThan(-1)
  expect(endIndex, `Missing end marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

const functionBody = (name: string) => {
  const marker = `const ${name}`
  const start = source.indexOf(marker)
  expect(start, `Missing function: ${name}`).toBeGreaterThan(-1)
  const firstBrace = source.indexOf('{', start)
  expect(firstBrace, `Missing function body: ${name}`).toBeGreaterThan(start)
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

const geminiBlock = between('<TabsContent value="gemini"', '<TabsContent value="launch"')
const mailBlock = between('<TabsContent value="mail"', '<TabsContent value="pay"')
const payBlock = between('<TabsContent value="pay"', '<TabsContent value="gemini"')
const launchBlock = between('<TabsContent value="launch"', '<TabsContent value="agent"')
const agentBlock = between('<TabsContent value="agent"', '<TabsContent value="turn"')
const turnBlock = between('<TabsContent value="turn"', '</Tabs>')

describe('Gemini / AI workspace organization', () => {
  test('keeps AdminSystemTab TSX parseable through supported TypeScript API', () => {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('keeps the six system tabs and confines Gemini workspace state to Gemini UI', () => {
    for (const tab of ['mail', 'pay', 'gemini', 'launch', 'agent', 'turn']) {
      required(source, `<TabsTrigger value="${tab}"`)
      required(source, `<TabsContent value="${tab}"`)
    }
    for (const adjacent of [mailBlock, payBlock, launchBlock, agentBlock, turnBlock]) {
      expect(adjacent.includes('openGeminiSection')).toBe(false)
      expect(adjacent.includes('gemini-section-')).toBe(false)
    }
  })

  test('adds exactly one visual section state with core as the default', () => {
    required(source, "const [openGeminiSection, setOpenGeminiSection] = useState<'core' | 'routing' | 'providers' | 'health' | 'cooldowns' | 'tests'>('core')")
    expect(occurrences(source, "useState<'core' | 'routing' | 'providers' | 'health' | 'cooldowns' | 'tests'>")).toBe(1)
  })

  test('renders the six Gemini workspaces as buttons that only change visual state', () => {
    for (const [value, title] of [
      ['core', 'Gemini الأساسي والصوت الحي'],
      ['routing', 'سياسات توجيه الذكاء'],
      ['providers', 'مزوّدو النصوص والمفاتيح'],
      ['health', 'صحة النماذج وتشخيصها'],
      ['cooldowns', 'حالات الراوتر والتبريد'],
      ['tests', 'اختبارات الاتصال'],
    ]) {
      required(geminiBlock, `'${value}', '${title}'`)
      required(geminiBlock, `id="gemini-section-${value}"`)
    }
    required(geminiBlock, 'type="button"')
    required(geminiBlock, 'aria-expanded={active}')
    required(geminiBlock, 'aria-controls={`gemini-section-${value}`}')
    required(geminiBlock, 'onClick={() => setOpenGeminiSection(value)}')
    expect(geminiBlock.includes('onClick={() => { setOpenGeminiSection')).toBe(false)
  })

  test('keeps workspaces mounted and hides them with hidden wrappers', () => {
    for (const value of ['core', 'routing', 'providers', 'health', 'cooldowns', 'tests']) {
      required(geminiBlock, `hidden={openGeminiSection !== '${value}'}`)
    }
    expect(geminiBlock.includes("openGeminiSection === 'routing' &&")).toBe(false)
    expect(geminiBlock.includes("openGeminiSection === 'providers' &&")).toBe(false)
    expect(geminiBlock.includes("openGeminiSection === 'health' &&")).toBe(false)
  })

  test('keeps Gemini core and live voice fields unchanged', () => {
    for (const key of [
      'GEMINI_API_KEY',
      'GEMINI_TEXT_MODEL',
      'GEMINI_TTS_MODEL',
      'GEMINI_TTS_VOICE',
      'GEMINI_SUPERVISOR_LIVE_MODEL',
      'GEMINI_DISCUSSION_LIVE_MODEL',
      'GEMINI_DISCUSSION_THINKING_LEVEL',
    ]) required(geminiBlock, key)

    for (const choices of [
      'GEMINI_VOICE_CHOICES',
      'GEMINI_SUPERVISOR_LIVE_MODEL_CHOICES',
      'GEMINI_DISCUSSION_LIVE_MODEL_CHOICES',
      'GEMINI_THINKING_CHOICES',
    ]) required(geminiBlock, choices)
  })

  test('keeps routing policy fields and switches unchanged', () => {
    for (const key of [
      'AI_TEXT_PROVIDER',
      'AI_ROUTER_POLICY',
      'AI_ROUTER_POLICY_SOURCE',
      'AI_POLICY_RANK_BY',
      'AI_PROVIDER_TIERS',
      'AI_PAID_FIRST',
      'AI_FAMILY_QUALITY_ORDER',
      'AI_FAMILY_COST_ORDER',
      'AI_ROUTER_COOLDOWN_MINUTES',
      'AI_ACADEMIC_ALLOWLIST',
      'AI_ACADEMIC_ALLOWLIST_STRICT',
      'AI_VERIFIER_PREFERRED',
      'AI_VERIFIER_STRICT',
      'AI_STICKY_ON_SUCCESS',
      'AI_ROUTER_ALLOW_PUBLIC_GATEWAYS',
    ]) required(geminiBlock, key)

    required(geminiBlock, "onCheckedChange={(v) => set('AI_PAID_FIRST', v ? 'true' : 'false')}")
    required(geminiBlock, "onCheckedChange={(v) => set('AI_ROUTER_ALLOW_PUBLIC_GATEWAYS', v ? '1' : '0')}")
  })

  test('keeps all provider-specific display conditions and fields', () => {
    for (const provider of [
      'GEMINI',
      'OPENAI',
      'ANTHROPIC',
      'ZAI',
      'GROQ',
      'OPENROUTER',
      'DEEPINFRA',
      'TOGETHER',
      'UNOROUTER',
      'ALBORIHI',
      'RELAYROUTER',
      'TOPTOOLS',
      'OPENAI_COMPAT',
    ]) {
      required(geminiBlock, `currentTextProvider === '${provider}' || currentTextProvider === 'AUTO'`)
    }

    for (const key of [
      'GEMINI_API_KEYS',
      'OPENAI_API_KEY',
      'OPENAI_API_KEYS',
      'OPENAI_TEXT_MODEL',
      'OPENAI_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEYS',
      'ANTHROPIC_TEXT_MODEL',
      'ZAI_API_KEY',
      'ZAI_API_KEYS',
      'ZAI_TEXT_MODEL',
      'ZAI_API_BASE',
      'GROQ_API_KEYS',
      'GROQ_TEXT_MODEL',
      'GROQ_API_BASE',
      'OPENROUTER_API_KEYS',
      'OPENROUTER_TEXT_MODEL',
      'OPENROUTER_BASE_URL',
      'DEEPINFRA_API_KEYS',
      'DEEPINFRA_TEXT_MODEL',
      'DEEPINFRA_BASE_URL',
      'TOGETHER_API_KEYS',
      'TOGETHER_TEXT_MODEL',
      'TOGETHER_BASE_URL',
      'UNOROUTER_API_KEYS',
      'UNOROUTER_TEXT_MODEL',
      'UNOROUTER_BASE_URL',
      'ALBORIHI_API_KEYS',
      'ALBORIHI_TEXT_MODEL',
      'ALBORIHI_BASE_URL',
      'RELAYROUTER_API_KEYS',
      'RELAYROUTER_TEXT_MODEL',
      'RELAYROUTER_BASE_URL',
      'TOPTOOLS_API_KEYS',
      'TOPTOOLS_TEXT_MODEL',
      'TOPTOOLS_BASE_URL',
      'OPENAI_COMPAT_API_KEYS',
      'OPENAI_COMPAT_TEXT_MODEL',
      'OPENAI_COMPAT_BASE_URL',
    ]) required(geminiBlock, key)
  })

  test('keeps diagnostics, model health, router state, and protected actions', () => {
    for (const text of [
      'textAiDiag?.message',
      'textAiDiag?.lastResult',
      'textAiDiag?.keyCounts',
      'textAiDiag?.cooldowns',
      'loadTextModelHealth',
      'checkAllTextModelsNow',
      'toggleAiModel',
      'addAcademicAllowlistModel',
      'routerState',
      'routerStateLoading',
      'routerStateClearing',
      'loadRouterState',
      'clearRouterStateItem',
      'clearRouterProvider',
      'routerStateTypeLabels',
    ]) required(geminiBlock, text)

    for (const state of ['KEY_COOLDOWN', 'MODEL_COOLDOWN', 'PROVIDER_COOLDOWN', 'NO_BALANCE', 'MODEL_DEAD']) required(source, state)
  })

  test('keeps save and tests connected to the original functions only', () => {
    required(geminiBlock, '<Button onClick={save} disabled={saving}')
    required(geminiBlock, 'حفظ إعدادات النظام')
    required(geminiBlock, 'الحفظ يستخدم نفس دالة save الحالية')
    required(geminiBlock, 'id="gemini-section-tests"')
    required(geminiBlock, '<Button onClick={testGeminiText} disabled={testing}')
    required(geminiBlock, '<Button onClick={testTextAi} disabled={testing}')
    required(geminiBlock, "<Button onClick={() => testGeminiLive('SUPERVISOR')} disabled={testing}")
    required(geminiBlock, "<Button onClick={() => testGeminiLive('DISCUSSION')} disabled={testing}")
  })

  test('keeps load/save API contracts and does not add section-driven API calls', () => {
    required(source, "api<SystemData>('/api/admin/system')")
    required(source, "api<{ ok: boolean; values: Record<string, string>; gemini?: SystemData['gemini']; textAi?: SystemData['textAi']; agent?: SystemData['agent'] }>('/api/admin/system', {")
    required(source, "method: 'PATCH'")
    required(source, 'body: JSON.stringify(form)')
    expect(geminiBlock.includes('setOpenGeminiSection(value); load')).toBe(false)
    expect(geminiBlock.includes('setOpenGeminiSection(value); save')).toBe(false)
    expect(geminiBlock.includes('setOpenGeminiSection(value); test')).toBe(false)
  })

  test('keeps F and SelectF helpers and does not expose secrets in summaries', () => {
    required(source, 'const F = (')
    required(source, 'const SelectF = (')
    required(geminiBlock, 'activeMask')
    expect(geminiBlock.includes('localStorage')).toBe(false)
    expect(geminiBlock.includes('console.log')).toBe(false)
    expect(geminiBlock.includes('navigator.clipboard')).toBe(false)
  })
})
