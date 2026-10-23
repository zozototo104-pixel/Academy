import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Read-only source guard: no representative records, APIs, or credentials are accessed.
const source = readFileSync(resolve(process.cwd(), 'src/components/aact/AdminRepresentativesTab.tsx'), 'utf8')
const file = ts.createSourceFile('AdminRepresentativesTab.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function descendants(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => { found.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return found
}

const all = descendants(file)
const jsx = all.filter((node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
function attribute(node: ts.Node, name: string): string | undefined {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
  const attr = opening?.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(file) === name)
  const initial = attr?.initializer
  if (initial && ts.isStringLiteral(initial)) return initial.text
  if (initial && ts.isJsxExpression(initial)) return initial.expression?.getText(file)
  return undefined
}
function byId(id: string): ts.Node {
  const matches = jsx.filter((node) => attribute(node, 'id') === id)
  assert.equal(matches.length, 1, `Expected one JSX element with id ${id}`)
  return matches[0]
}
function textOf(node: ts.Node) { return source.slice(node.getStart(file), node.end) }
const keys = ['basic', 'bio', 'uploads', 'onboarding'] as const
const titles = ['البيانات الأساسية', 'السيرة والنصوص', 'الصور والكرنيه والرفع', 'الاستكمال وملفات الممثل']

describe('representatives workspace organization', () => {
  it('keeps the component syntactically valid TSX', () => {
    assert.equal(file.parseDiagnostics.length, 0, file.parseDiagnostics.map((d) => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`).join('\n'))
  })

  it('exposes four mutually exclusive, accessible, always-mounted panels and summaries', () => {
    assert.match(source, /const \[openSection, setOpenSection\] = useState<[^>]+>\('basic'\)/)
    keys.forEach((key, index) => {
      const heading = byId(`representatives-heading-${key}`)
      const panel = byId(`representatives-panel-${key}`)
      assert.ok(textOf(heading).includes(titles[index]), `Missing title ${titles[index]}`)
      assert.equal(attribute(heading, 'aria-controls'), `representatives-panel-${key}`)
      assert.equal(attribute(heading, 'aria-expanded'), `openSection === '${key}'`)
      assert.ok(textOf(heading).includes(`setOpenSection('${key}')`))
      assert.equal(attribute(panel, 'hidden'), `openSection !== '${key}'`)
      assert.equal(attribute(panel, 'aria-labelledby'), `representatives-heading-${key}`)
      assert.equal(attribute(panel, 'role'), 'region')
      assert.ok(textOf(heading).includes(`representatives-summary-${key}`), `Missing summary ${key}`)
    })
  })

  it('keeps every existing field, uploader, QR and review list inside its correct panel', () => {
    const panels = Object.fromEntries(keys.map((key) => [key, textOf(byId(`representatives-panel-${key}`))])) as Record<(typeof keys)[number], string>
    for (const name of ['fullName', 'country', 'sortOrder', 'featured']) assert.ok(panels.basic.includes(name), `Basic: ${name}`)
    for (const name of ['shortBio', 'publicContactNote', 'rawBio', 'professionalBio', 'worksSummary', 'achievements']) assert.ok(panels.bio.includes(`update('${name}'`), `Bio: ${name}`)
    for (const text of ['AssetUploader label="الصورة الشخصية"', 'AssetUploader label="الكرنيه الرسمي"', 'PresetFileUploader', 'GeneralFileUploader', 'ExternalLinkUploader', 'PreviewBox', 'رابط التحقق الآمن']) assert.ok(panels.uploads.includes(text), `Uploads: ${text}`)
    for (const text of ['رابط استكمال ملف الممثل', 'createOnboardingLink', 'copyOnboardingLink', 'revokeOnboardingLink', '(selected?.files || []).map', 'reviewFile', 'deleteFile']) assert.ok(panels.onboarding.includes(text), `Onboarding: ${text}`)
    assert.ok(!panels.uploads.includes('(selected?.files || []).map'))
    assert.ok(!panels.onboarding.includes('AssetUploader label="الصورة الشخصية"'))
    assert.ok(source.includes("file.reviewStatus || 'APPROVED'"), 'Pending summary must respect the review-list status default')
  })

  it('keeps the completion alert above the panels and Save/AI/Delete actions after them', () => {
    const basic = byId('representatives-panel-basic')
    const last = byId('representatives-panel-onboarding')
    const right = source.indexOf('data-testid="representatives-workspace"')
    assert.ok(right > 0)
    const alertStart = source.indexOf('حالة استكمال ملف الممثل:', right)
    assert.ok(alertStart > right && alertStart < basic.getStart(file))
    const after = source.slice(last.end, source.indexOf('</CardContent>', last.end))
    for (const action of ['onClick={save}', 'onClick={rewrite}', 'onClick={remove}']) assert.ok(after.includes(action), `Action not always visible: ${action}`)
  })

  it('preserves the left directory, selection, APIs, and canonical action names', () => {
    const left = source.slice(source.indexOf('return (\n    <div'), source.indexOf('data-testid="representatives-workspace"'))
    for (const marker of ['value={query}', 'filtered.map((rep)', 'choose(rep)', 'onClick={newRepresentative}']) assert.ok(left.includes(marker), `Directory changed: ${marker}`)
    assert.equal((source.match(/\/api\/admin\/representatives/g) || []).length, 13)
    const canonical = ['load', 'save', 'remove', 'upload', 'rewrite', 'deleteFile', 'reviewFile', 'createOnboardingLink', 'revokeOnboardingLink', 'copyOnboardingLink', 'choose', 'newRepresentative', 'update']
    for (const name of canonical) {
      const functions = all.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
      assert.equal(functions.length, 1, `Canonical function must remain singular: ${name}`)
      if (name === 'choose' || name === 'newRepresentative') assert.ok(!textOf(functions[0]).includes('setOpenSection'), `Selection should keep the currently open section: ${name}`)
    }
  })
})
