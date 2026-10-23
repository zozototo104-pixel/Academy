import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'

const filename = resolve(process.cwd(), 'src/components/aact/AdminRepresentativesTab.tsx')
const source = readFileSync(filename, 'utf8')
const script = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

// These fingerprints were recorded from the tab before the UI-only reorganization.
// Printing AST bodies normalizes formatting but preserves the code and literal values.
const protectedBodies: Record<string, string> = {
  load: 'e834b474bb0fdd0cb8ca4906043bdfaf1811e9f74dc574979e3f1bc5aa0a21b9',
  update: '3272c5733e9f7e65d16a2f51a458a3362c0c5a57cd112fc2e85bd23b5542b6d4',
  newRepresentative: '52cb704a1183faaf221c600c06e9f552b305485574a56519cc6a85754d60818f',
  choose: '8784959d2896a54ec332c8e54c3438ed1dabd0a5509e76c922435461a39c335a',
  save: '32f074d03b718848bdcb6c39c948f12f1548b2b7bb7dfa6012f3863c40787731',
  remove: '5aeec75f782cd808e845b3862fdcf70a3be54a9286c70c6bd8bf8736b97b8a4e',
  upload: '2bd961c112019ab7945801d80e2f5ad16e11f785ffd6ca43d9065e7fb4086758',
  deleteFile: '8738aa547bc36b405561028bbc64ea5ddaddde958dfe9d4bbcf9cb12d7b5a978',
  createOnboardingLink: 'c876db24373a7a12623cfa8097e06d36a276eb55088bbac63d4c8bd9419970db',
  revokeOnboardingLink: 'a605f908c0d530e90943eedc1b48990d80acbce4cb281e5de8440ec3809b2ad5',
  copyOnboardingLink: '190d5fbb0c561adcd6994b7b15bf763abab21d038c57bb87458dcedf90194264',
  reviewFile: '8977373ec0944a85708365f9f03d3c2bd39dfed09f58057c4c3bae40f22e72ae',
  rewrite: 'f3dadafcb73dc16e4ce45f9c52a0816816e2ef542a316ccd34c08fe6390fe40a',
  formFromRepresentative: '6135e271b5edf6dae55ab57b8d61953362910dc0f5004fdb898a1c6ee17be0e1',
  CountryCombobox: 'e6b7c03fd7dd8fed7b477d2615bf355cc8d794de867770dd79d63209dccffb5e',
  AssetUploader: 'ed91a2fc4257113d6b8cd189afb94fb2d820b6cc5fd023222e5f632b34cd0bdd',
  PresetFileUploader: '140e67d01680892bf3062ce4b7c22c1f0ace2bd9ef72c1692eb838888632d0b2',
  GeneralFileUploader: '3d7d773693be27abed3d6ae98fc19c722140421f496d2e03d791efb43c984237',
  ExternalLinkUploader: 'b22c1fda1f45fb83a9d59c066be7161e7bbf1c02be72620ba02cfe86a8aeeb1d',
  PreviewBox: '01c23084ba2ee54a33ee5881c4ab6d795ed385537c768bca4ea637cd354d6d81',
}

function panelBody(section: string) {
  const begin = source.indexOf(`id="representatives-panel-${section}"`)
  const end = source.indexOf('</section>', begin)
  expect(begin, `missing panel ${section}`).toBeGreaterThan(-1)
  expect(end, `missing closing section ${section}`).toBeGreaterThan(begin)
  return source.slice(begin, end)
}

describe('representatives workspace organization', () => {
  it('has parseable TSX, preventing unmatched section and div regressions', () => {
    const diagnostics = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve } }).diagnostics || []
    expect(diagnostics.map((d) => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)).toEqual([])
  })

  it('keeps exactly four named, accessible, mutually exclusive and mounted sections', () => {
    expect(source).toContain("useState<'basic' | 'bio' | 'uploads' | 'onboarding'>('basic')")
    for (const [id, title] of Object.entries({ basic: 'البيانات الأساسية', bio: 'السيرة والنصوص', uploads: 'الصور والكرنيه والرفع', onboarding: 'الاستكمال وملفات الممثل' })) {
      expect(source).toContain(title)
      expect(source).toContain(`id="representatives-heading-${id}"`)
      expect(source).toContain(`id="representatives-panel-${id}"`)
      expect(source).toContain(`aria-expanded={openSection === '${id}'}`)
      expect(source).toContain(`hidden={openSection !== '${id}'}`)
      expect(source).toContain(`data-testid="representatives-summary-${id}"`)
      expect(source.match(new RegExp(`id="representatives-panel-${id}"`, 'g'))?.length).toBe(1)
    }
    expect(source).toContain("onClick={() => setOpenSection('uploads')}")
  })

  it('keeps form fields, uploaders, QR, link and file review in their respective sections', () => {
    const basic = panelBody('basic')
    const bio = panelBody('bio')
    const uploads = panelBody('uploads')
    const onboarding = panelBody('onboarding')
    for (const needle of ["update('fullName'", "update('status'", 'إظهار كممثل مميز']) expect(basic).toContain(needle)
    for (const needle of ['shortBio', 'publicContactNote', 'rawBio', 'professionalBio', 'worksSummary', 'achievements']) expect(bio).toContain(`update('${needle}'`)
    expect(uploads).toContain('احفظ بيانات الممثل أولاً')
    expect(uploads).toContain('AssetUploader label="الصورة الشخصية"')
    expect(uploads).toContain('GeneralFileUploader onUpload=')
    expect(uploads).toContain('ExternalLinkUploader onUpload=')
    expect(uploads).toContain('selected?.qrDataUrl')
    expect(uploads).toContain('رابط التحقق الآمن')
    expect(onboarding).toContain('رابط استكمال ملف الممثل')
    expect(onboarding).toContain('createOnboardingLink')
    expect(onboarding).toContain('(selected?.files || []).map(')
    expect(onboarding).toContain('reviewFile(')
    expect(onboarding).toContain('deleteFile(')
    expect(source.indexOf('حالة استكمال ملف الممثل:')).toBeLessThan(source.indexOf('id="representatives-heading-basic"'))
    const actions = source.indexOf('<Button onClick={save} disabled={saving}')
    expect(actions).toBeGreaterThan(source.indexOf('</section>', source.indexOf('id="representatives-panel-onboarding"')))
    expect(source).toContain('<Button onClick={rewrite}')
    expect(source).toContain('<Button onClick={remove}')
  })

  it('preserves index, API call count, and original domain handlers/helper bodies', () => {
    const index = source.slice(source.indexOf('return (\n    <div className="mt-4 grid'), source.indexOf('data-testid="representatives-workspace"'))
    for (const needle of ['value={query}', 'setQuery(e.target.value)', 'filtered.map((rep)', 'choose(rep)', 'onClick={newRepresentative}']) expect(index).toContain(needle)
    expect(source.split('/api/admin/representatives').length - 1).toBe(13)
    const actual: Record<string, string> = {}
    const printer = ts.createPrinter()
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body && protectedBodies[node.name.text]) {
        const printedBody = printer.printNode(ts.EmitHint.Unspecified, node.body, script)
        actual[node.name.text] = createHash('sha256').update(printedBody).digest('hex')
      }
      ts.forEachChild(node, visit)
    }
    visit(script)
    expect(actual).toEqual(protectedBodies)
  })
})
