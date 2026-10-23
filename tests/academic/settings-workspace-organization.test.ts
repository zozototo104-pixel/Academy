import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminExtras.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')

const settingsStart = source.indexOf('export function AdminSettingsTab()')
const adminsMarker = 'export function AdminAdminsTab()'
const adminsStart = source.indexOf(adminsMarker)
expect(settingsStart).toBeGreaterThan(-1)
expect(adminsStart).toBeGreaterThan(settingsStart)
const settingsBlock = source.slice(settingsStart, adminsStart)
const adminsAndAfter = source.slice(adminsStart)

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

const functionBody = (name: string) => {
  const marker = `const ${name}`
  const start = settingsBlock.indexOf(marker)
  expect(start, `Missing function: ${name}`).toBeGreaterThan(-1)
  const firstBrace = settingsBlock.indexOf('{', start)
  expect(firstBrace, `Missing body for: ${name}`).toBeGreaterThan(start)
  let depth = 0
  for (let i = firstBrace; i < settingsBlock.length; i += 1) {
    const char = settingsBlock[i]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return settingsBlock.slice(start, i + 1)
    }
  }
  throw new Error(`Unclosed function body: ${name}`)
}

const requireAll = (text: string, needles: string[]) => {
  for (const needle of needles) required(text, needle)
}

describe('AdminSettingsTab workspace organization', () => {
  test('keeps AdminExtras TSX parseable through supported TypeScript API', () => {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('confines the settings workspace state to AdminSettingsTab', () => {
    required(settingsBlock, "const [openSettingsSection, setOpenSettingsSection] = useState<'fees-ai' | 'rules' | 'content-contact' | 'admins'>('fees-ai')")
    expect(adminsAndAfter.includes('openSettingsSection')).toBe(false)
    expect(adminsAndAfter.includes('settings-group-')).toBe(false)
  })

  test('renders the four settings workspaces without changing behavior on open', () => {
    required(settingsBlock, 'aria-label="مساحات عمل الرسوم والقواعد"')
    for (const text of [
      "['fees-ai', 'الرسوم وباقات الذكاء'",
      "['rules', 'القواعد والمهل'",
      "['content-contact', 'النصوص والتواصل والاعتماد'",
      "['admins', 'مدراء النظام'",
    ]) required(settingsBlock, text)
    required(settingsBlock, 'type="button"')
    required(settingsBlock, 'aria-expanded={active}')
    required(settingsBlock, 'onClick={() => setOpenSettingsSection(value)}')
    expect(settingsBlock.includes('setOpenSettingsSection(value); save')).toBe(false)
    expect(settingsBlock.includes('setOpenSettingsSection(value); api')).toBe(false)
    expect(settingsBlock.includes('setOpenSettingsSection(value); load')).toBe(false)
  })

  test('keeps all settings groups mounted and only hides wrappers/cards', () => {
    required(settingsBlock, 'id="settings-section-admins"')
    required(settingsBlock, "hidden={openSettingsSection !== 'admins'}")
    required(settingsBlock, 'id={`settings-group-${g.key}`}')
    required(settingsBlock, "openSettingsSection === 'fees-ai'")
    required(settingsBlock, "!['FEES', 'AI'].includes(g.key)")
    required(settingsBlock, "g.key !== 'RULES'")
    required(settingsBlock, "!['CONTENT', 'CONTACT'].includes(g.key)")
  })

  test('keeps the settings groups and labels unchanged', () => {
    for (const label of [
      "{ key: 'FEES', label: 'الإعدادات المالية الافتراضية'",
      "{ key: 'AI', label: 'باقات المحادثة الصوتية للمشرف الذكي'",
      "{ key: 'RULES', label: 'المهل الزمنية والنسب وفق دليل الإجراءات وعقد التمثيل'",
      "{ key: 'CONTENT', label: 'نصوص عامة تظهر للطلاب والزوار'",
      "{ key: 'CONTACT', label: 'بيانات التواصل الرسمية'",
    ]) required(settingsBlock, label)
  })

  test('keeps general settings load and save contracts unchanged', () => {
    required(settingsBlock, "api<{ values: any; defs?: any[] }>('/api/settings')")
    requireAll(functionBody('save'), [
      'setSaving(true)',
      'const currentValues = { ...values }',
      'document.getElementById(d.key)',
      "api<{ values?: Record<string, string> }>('/api/settings', { method: 'PUT', body: JSON.stringify({ values: currentValues }) })",
      "toast({ title: 'حُفظت الإعدادات العامة'",
      'setSaving(false)',
    ])
  })

  test('keeps system admin contracts unchanged', () => {
    requireAll(functionBody('loadSystemAdmins'), [
      'setAdminsLoading(true)',
      "api<{ admins: SystemAdminAccount[] }>('/api/admin/system-admins')",
      'setAdmins(Array.isArray(d.admins) ? d.admins : [])',
      'setAdminsLoading(false)',
    ])
    requireAll(functionBody('createSystemAdmin'), [
      "await api('/api/admin/system-admins', {",
      "method: 'POST'",
      'body: JSON.stringify({ ...adminForm, email })',
      "setAdminForm((prev) => ({ ...prev, password: '' }))",
      'loadSystemAdmins()',
    ])
    requireAll(functionBody('disableSystemAdmin'), [
      'confirmAction({',
      "await api(`/api/admin/system-admins?id=${encodeURIComponent(admin.id)}`, { method: 'DELETE' })",
      'loadSystemAdmins()',
      'setAdminBusy(null)',
    ])
  })

  test('keeps AI cooldown and accreditation contracts unchanged', () => {
    requireAll(functionBody('clearAiCooldown'), [
      'setAiCooldownBusy(true)',
      "api<{ count: number }>('/api/settings/ai-cooldown', { method: 'POST', body: JSON.stringify({ provider: aiCooldownProvider }) })",
      "toast({ title: 'تم مسح تبريد المزود'",
      'setAiCooldownBusy(false)',
    ])
    required(settingsBlock, "api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation')")
    required(settingsBlock, "api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation', { method: 'PUT', body: JSON.stringify({ profile }) })")
    required(settingsBlock, "api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation/documents', { method: 'POST', body: form })")
    required(settingsBlock, "api<{ profile: AccreditationAdminProfile }>(`/api/admin/accreditation/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' })")
  })

  test('keeps official contact and accreditation special renderers reachable', () => {
    required(settingsBlock, "if (d.key === 'ACCREDITATION_PAGE')")
    required(settingsBlock, "if (d.key === 'OFFICIAL_CONTACT')")
    required(settingsBlock, 'الشراكات والاعتمادات')
    required(settingsBlock, 'رفع وثيقة اعتماد / شراكة')
    required(settingsBlock, 'أرقام الهاتف الرسمية')
    required(settingsBlock, 'أرقام الواتساب الرسمية')
  })

  test('keeps the global save button available outside hidden groups', () => {
    const switcher = settingsBlock.indexOf('aria-label="مساحات عمل الرسوم والقواعد"')
    const firstGroup = settingsBlock.indexOf('{groups.map((g) => (')
    const headerSave = settingsBlock.indexOf('حفظ كل التعديلات')
    const footerSave = settingsBlock.indexOf('حفظ التعديلات (بدون كود — فوري)')
    expect(headerSave).toBeGreaterThan(-1)
    expect(headerSave).toBeLessThan(switcher)
    expect(headerSave).toBeLessThan(firstGroup)
    expect(footerSave).toBeGreaterThan(firstGroup)
  })
})
