import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Recorded before restructuring from the original AdminRepresentativesTab.tsx on main.
// The test intentionally runs without Git history or network access.
const ORIGINAL_DIRECTORY_SHA256 = '73492fa6b2a1256884c21abc643b9563bc1d7892b0fa9bac74b6a5371f5b5cc8'
const ORIGINAL_API_PATH_OCCURRENCES = 13
const ORIGINAL_HANDLER_HASHES: Record<string, string> = {
  formFromRepresentative: '9ac2d544eceab4bf81166ef6d4f42595075a31b0d65930f893bd5a4aa596f117',
  load: 'ff65c141c3e9b573eebaa591869dde469dd30d6565f1d0ed3fde4abf446e0f5c',
  update: '3b106fa7a01c7003c77d9bb1dd011d29c9979e45f0189871c7d4295937b1c2fe',
  newRepresentative: '6cf0956184a43df46ad29567f0aaeaf815eb1c73cc9761ede507319a0ec5ef14',
  choose: '30c5be767037cf4c8de560de7661ee5ea528e0d193a9acb7d3cdeb88a118facf',
  save: 'e0078f020a4cdf14e2214930c74107d44b5cc14ba21523bd95ed08af082c3f88',
  remove: 'f84df0eba7b1f277fa633d83878725f6edd8097452fa507679699c3b3890efbc',
  upload: '8b7d0fce4ba82644af91d57a829060d50f70a9d1b52199954d61d7b0500a8e89',
  deleteFile: '0eae3b73496589fe6b63cb800fff83d5a1b63c47ebacc08a03c02067d9f638f7',
  createOnboardingLink: 'b2b4f91530a823a60d8be17508e9a0b7e16cc7d77e664c153e7eee720ebb1ce0',
  revokeOnboardingLink: 'b9240195f2db1fe3ecb622954616075c5cf81a5f64506b59ff603a13c7e4d8a7',
  copyOnboardingLink: 'c37a12147abefa3b041fd9386e0240b69fdf424ef15d3a54a55efc6f56910d2a',
  reviewFile: '4b55193280d8262eaf0690384b9ef8020c8f50b979bd87704c0a54027aa7790e',
  rewrite: '25538958352b30975ec03bb6d341248a62425e3aeb0c0264c3ca2fcbf3c9e0e0',
}

const code = readFileSync(resolve(process.cwd(), 'src/components/aact/AdminRepresentativesTab.tsx'), 'utf8')
const source = ts.createSourceFile('AdminRepresentativesTab.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const compact = (value: string) => value.replace(/\s+/g, ' ').trim()
const sections = ['basic', 'bio', 'uploads', 'onboarding'] as const

function panelText(section: (typeof sections)[number]): string {
  const id = `representatives-panel-${section}`
  let result: string | null = null
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node)) {
      const prop = node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === 'id')
      if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === id) {
        result = node.parent.getText(source)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(result, `Missing mounted panel: ${id}`)
  return result
}

describe('representatives accordion structure', () => {
  it('parses as TSX without an unclosed JSX element', () => {
    const { diagnostics = [] } = ts.transpileModule(code, {
      fileName: 'AdminRepresentativesTab.tsx',
      compilerOptions: { jsx: ts.JsxEmit.Preserve },
      reportDiagnostics: true,
    })
    assert.equal(diagnostics.length, 0, diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  })

  it('uses four exclusive, mounted panels with visible section summaries', () => {
    assert.ok(code.includes("useState<'basic' | 'bio' | 'uploads' | 'onboarding' | null>('basic')"))
    assert.ok(code.includes('const toggleSection ='))
    assert.ok(code.includes("setOpenSection((current) => (current === section ? null : section))"))
    assert.ok(code.includes("window.scrollTo({ top: y, behavior: 'auto' })"))
    const headings = sections.map((section) => {
      const headingId = `id="representatives-heading-${section}"`
      assert.equal(code.split(headingId).length - 1, 1, `Heading ${section} must be unique`)
      assert.equal(code.split(`data-testid="representatives-summary-${section}"`).length - 1, 1)
      assert.ok(code.includes(`hidden={openSection !== '${section}'}`))
      assert.ok(code.includes(`aria-expanded={openSection === '${section}'}`))
      assert.ok(panelText(section).includes('role="region"'))
      return code.indexOf(headingId)
    })
    assert.deepEqual([...headings].sort((a, b) => a - b), headings)
    for (const title of ['البيانات الأساسية', 'السيرة والنصوص', 'الصور والكرنيه والرفع', 'الاستكمال وملفات الممثل']) assert.ok(code.includes(title))
  })

  it('keeps the expected content inside each panel', () => {
    const basic = panelText('basic')
    const bio = panelText('bio')
    const uploads = panelText('uploads')
    const onboarding = panelText('onboarding')
    for (const key of ['fullName', 'country', 'status', 'sortOrder', 'featured']) assert.ok(basic.includes(key), `Basic: ${key}`)
    for (const key of ['shortBio', 'publicContactNote', 'rawBio', 'professionalBio', 'worksSummary', 'achievements']) assert.ok(bio.includes(`update('${key}'`), `Bio: ${key}`)
    for (const marker of ['الصورة الشخصية', 'الكرنيه الرسمي', 'GeneralFileUploader', 'ExternalLinkUploader', 'رابط التحقق الآمن', 'qrDataUrl']) assert.ok(uploads.includes(marker), `Uploads: ${marker}`)
    for (const marker of ['رابط استكمال ملف الممثل', 'createOnboardingLink', 'revokeOnboardingLink', 'copyOnboardingLink', '(selected?.files || []).map', 'reviewFile', 'deleteFile']) assert.ok(onboarding.includes(marker), `Onboarding/files: ${marker}`)
    assert.ok(onboarding.includes('selected?.files || []'), 'Header count must derive from the same files source')
  })

  it('leaves the notice and Save/Rewrite/Delete actions outside all foldable panels', () => {
    assert.equal(code.split('حالة استكمال ملف الممثل:').length - 1, 1)
    assert.equal(code.split('<Button onClick={save} disabled={saving}').length - 1, 1)
    assert.ok(code.indexOf('حالة استكمال ملف الممثل:') < code.indexOf('id="representatives-heading-basic"'))
    assert.ok(code.indexOf('<Button onClick={save} disabled={saving}') > code.indexOf('id="representatives-heading-onboarding"'))
    for (const section of sections) {
      const panel = panelText(section)
      assert.ok(!panel.includes('<Button onClick={save} disabled={saving}'))
      assert.ok(!panel.includes('حالة استكمال ملف الممثل:'))
    }
  })

  it('preserves the original sidebar structure and representative API occurrences', () => {
    const start = code.indexOf('      <Card className="min-w-0 overflow-hidden border-[#0f2b46]/10">')
    assert.ok(start >= 0)
    const end = code.indexOf('      </Card>', start)
    assert.ok(end > start)
    const sidebar = code.slice(start, end + '      </Card>'.length)
    assert.equal(digest(compact(sidebar)), ORIGINAL_DIRECTORY_SHA256)
    assert.ok(sidebar.includes('filtered.map((rep)'))
    assert.ok(sidebar.includes('choose(rep)'))
    assert.ok(sidebar.includes('value={query}'))
    assert.equal(code.split('/api/admin/representatives').length - 1, ORIGINAL_API_PATH_OCCURRENCES)
  })

  it('does not alter original load, mutation, selection, and onboarding function bodies', () => {
    const found = new Map<string, string>()
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        found.set(node.name.text, digest(compact(node.body.getText(source))))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const [name, expected] of Object.entries(ORIGINAL_HANDLER_HASHES)) {
      assert.equal(found.get(name), expected, `Body changed unexpectedly: ${name}`)
    }
  })
})
