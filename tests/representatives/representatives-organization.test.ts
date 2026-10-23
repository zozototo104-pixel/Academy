import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Fixed baseline captured from AdminRepresentativesTab.tsx on main, blob
// 9468e4d01208e8d6bf866919fb4594eeb6f66334, before any accordion changes.
// The fingerprint canonicalizer folds JSX indentation but preserves literal text,
// attributes, expressions, and the complete unchanged contents of every block.
const BASELINE = {
  header: '00597a2e620c645e098284ef9ab2da06c0019f6df3012f9a577c17c89e068bea',
  logic: 'eba52f8c49319be9881fa95b048b763e53c239d20cda10a3a57d93276023e922',
  helpers: '2260452c7a398cab346b8b27d4e392749558e8d4bd4d78230b4de772074251e7',
  endpoints: 13,
  names: {
    load: 8, save: 3, remove: 2, upload: 6, rewrite: 4, deleteFile: 2,
    reviewFile: 3, createOnboardingLink: 2, revokeOnboardingLink: 2,
    copyOnboardingLink: 2, choose: 2, newRepresentative: 3, update: 26,
  },
  blocks: {
    index: 'b690575f0dc51bae7314055635891756fd1afcd335c8ef97221a2a943877c85e',
    notice: '7cccf47597b01e355a30ccebaabc79070c8855218b381d3e35f21a0e41d9dc0e',
    fields: '9883ceee26f1f9dc2e2a0552a5789ff80da1cd5819922d417a9e51b276e2b2e0',
    featured: '9e6f769c5cc7000cdc88588132261ef7ee88a2c60cfd17844059b8c04da9af5b',
    bios: '6ef62072cbb32a2094c84f3dfd82f9732129b7864752c20bc882d2af52397f9c',
    actions: 'afd5fd62b94b2227ee69941925d65272aefe69f6e0844a63bc8fd34cf6d97e3e',
    saveNotice: '2856bd889e1e030e2e517e36769fe4e3f82203a98b6bf4ff75940a989cbd3a01f4',
    info: '10be27c14833e060f86ac0f356d11cba346489eb9ccff051c0543a8ea6f74891',
    onboarding: '8aed71d0d98d7b5438f49002508acdb89d16959effe604c5f1adc7bc448260f2',
    uploaders: '0f2cc895db079107646688af714462b5d870ecf3c5703653c5a77084f9acb614',
    general: '27ee81492a19b1878fbac50c089a5fa7bf33dec01d0cd9977857fbd5d14c9674',
    external: '3b88b1a796efc1e509b030e4e3fbef906dd35469d399edd6c0da24dd345eae99',
    previews: '0f5302550e792817ce17e6c41a30ee56342b0fdedf3023f7ea30bc0a93868d88',
    qr: '0a0087597260a6dd5b383fc8475475797b11d1ab1539acba6b50fa863f1f1956',
    files: 'cf8e23f8a88e1c2ec08491c66346183db55a233cb0240a090b1b554df13dadec',
  },
}

const source = readFileSync(resolve(process.cwd(), 'src/components/aact/AdminRepresentativesTab.tsx'), 'utf8')
const sf = ts.createSourceFile('AdminRepresentativesTab.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (node: ts.Node) => { out.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return out
}

function jsxText(text: string) {
  const lines = text.split(/\r\n|\n|\r/)
  let last = 0
  lines.forEach((line, i) => { if (/[^ \t]/.test(line)) last = i })
  let result = ''
  lines.forEach((line, i) => {
    let value = line.replace(/\t/g, ' ')
    if (i !== 0) value = value.replace(/^ +/, '')
    if (i !== lines.length - 1) value = value.replace(/ +$/, '')
    if (value) result += value + (i !== last ? ' ' : '')
  })
  return result
}

function canonical(node: ts.Node): unknown {
  if (ts.isJsxText(node)) {
    const value = jsxText(node.text)
    return value ? [node.kind, value] : undefined
  }
  const children: ts.Node[] = []
  ts.forEachChild(node, (child) => { children.push(child) })
  return children.length
    ? [node.kind, children.map(canonical).filter((value) => value !== undefined)]
    : [node.kind, node.getText(sf)]
}

const fingerprint = (node: ts.Node) => digest(JSON.stringify(canonical(node)))
const all = nodes(sf)
const jsxNodes = all.filter((node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxExpression(node))
const component = sf.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'AdminRepresentativesTab')!
const renderReturn = component.body!.statements.find(ts.isReturnStatement)!

function opening(node: ts.Node) {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
}
function attr(node: ts.Node, name: string) {
  return opening(node)?.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText(sf) === name)?.initializer
}
function attrText(node: ts.Node, name: string): string | undefined {
  const value = attr(node, name)
  if (value && ts.isStringLiteral(value)) return value.text
  if (value && ts.isJsxExpression(value)) return value.expression?.getText(sf)
  return undefined
}
function one<T>(values: T[], label: string): T {
  assert.equal(values.length, 1, `${label}: expected one, found ${values.length}`)
  return values[0]
}
const byId = (id: string) => one(jsxNodes.filter((node) => attrText(node, 'id') === id), id)
const within = (outer: ts.Node, inner: ts.Node) => inner.getStart(sf) >= outer.getStart(sf) && inner.end <= outer.end
const keys = ['basic', 'bio', 'uploads', 'onboarding'] as const
const titles = ['البيانات الأساسية', 'السيرة والنصوص', 'الصور والكرنيه والرفع', 'الاستكمال وملفات الممثل']
const panels = () => keys.map((key) => byId(`representatives-panel-${key}`))

function protectedLogic() {
  return component.body!.statements
    .filter((node) => node.pos < renderReturn.pos && !(
      ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) =>
        ts.isArrayBindingPattern(decl.name) && decl.name.elements.some((element) =>
          ts.isBindingElement(element) && element.name.getText(sf) === 'openSection'))))
    .map((node) => node.getText(sf)).join('\n')
}

describe('representatives organization: surgical preservation guard', () => {
  it('parses valid TSX without dangling JSX tags', () => {
    assert.equal(sf.parseDiagnostics.length, 0,
      sf.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  })
  it('keeps imports, all existing logic/functions, and helper components byte-identical', () => {
    assert.equal(digest(source.slice(0, component.getStart(sf))), BASELINE.header)
    assert.equal(digest(protectedLogic()), BASELINE.logic)
    assert.equal(digest(source.slice(component.end)), BASELINE.helpers)
  })
  it('keeps endpoint and protected function-name occurrence counts unchanged', () => {
    assert.equal((source.match(/\/api\/admin\/representatives/g) || []).length, BASELINE.endpoints)
    for (const [name, count] of Object.entries(BASELINE.names)) {
      assert.equal((source.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length, count, name)
    }
  })
  it('opens basic by default and changes active section only from header clicks', () => {
    const state = one(all.filter((node) => ts.isVariableDeclaration(node)
      && ts.isArrayBindingPattern(node.name) && node.name.getText(sf) === '[openSection, setOpenSection]'), 'openSection state') as ts.VariableDeclaration
    assert.equal((state.initializer as ts.CallExpression).arguments[0].getText(sf), "'basic'")
    const setters = all.filter((node) => ts.isCallExpression(node) && node.expression.getText(sf) === 'setOpenSection')
    assert.equal(setters.length, 4)
    keys.forEach((key) => {
      const header = byId(`representatives-heading-${key}`)
      assert.equal(attrText(header, 'onClick'), `() => setOpenSection('${key}')`)
      assert.ok(setters.some((setter) => within(header, setter)))
    })
  })
  it('renders exactly four mounted panels with accessible headers and summaries', () => {
    assert.equal(jsxNodes.filter((node) => attr(node, 'hidden')).length, 4)
    keys.forEach((key, index) => {
      const header = byId(`representatives-heading-${key}`)
      const panel = byId(`representatives-panel-${key}`)
      assert.equal(opening(header)?.tagName.getText(sf), 'button')
      assert.equal(attrText(header, 'type'), 'button')
      assert.equal(attrText(header, 'aria-controls'), `representatives-panel-${key}`)
      assert.equal(attrText(header, 'aria-expanded'), `openSection === '${key}'`)
      assert.equal(attrText(panel, 'hidden'), `openSection !== '${key}'`)
      assert.equal(attrText(panel, 'aria-labelledby'), `representatives-heading-${key}`)
      assert.equal(attrText(panel, 'role'), 'region')
      assert.ok(nodes(header).some((node) => ts.isJsxText(node) && jsxText(node.text) === titles[index]))
      const summary = one(nodes(header).filter((node) => attrText(node, 'data-testid') === `representatives-summary-${key}`), `summary ${key}`)
      assert.ok(nodes(summary).some((node) => ts.isJsxExpression(node) && node.expression))
      assert.equal((panel.parent as ts.JsxElement).openingElement.tagName.getText(sf), 'section')
    })
  })
  it('moves original JSX blocks unchanged into the correct sections', () => {
    const owners: Record<string, string> = {
      fields: 'basic', featured: 'basic', bios: 'bio',
      saveNotice: 'uploads', info: 'uploads', uploaders: 'uploads',
      general: 'uploads', external: 'uploads', previews: 'uploads', qr: 'uploads',
      onboarding: 'onboarding', files: 'onboarding',
    }
    for (const [name, expectedHash] of Object.entries(BASELINE.blocks)) {
      const block = one(jsxNodes.filter((node) => fingerprint(node) === expectedHash), `unchanged JSX: ${name}`)
      if (owners[name]) {
        assert.ok(within(byId(`representatives-panel-${owners[name]}`), block), `${name} belongs to ${owners[name]}`)
        assert.equal(panels().filter((panel) => within(panel, block)).length, 1)
      } else {
        assert.ok(panels().every((panel) => !within(panel, block)), `${name} must remain outside panels`)
      }
    }
  })
  it('keeps notice permanently above sections, actions below them, and index unchanged', () => {
    const findBlock = (name: keyof typeof BASELINE.blocks) =>
      one(jsxNodes.filter((node) => fingerprint(node) === BASELINE.blocks[name]), name)
    const notice = findBlock('notice')
    const actions = findBlock('actions')
    const index = findBlock('index')
    for (const panel of panels()) {
      assert.ok(notice.end < panel.getStart(sf))
      assert.ok(actions.getStart(sf) > panel.end)
      assert.ok(!within(panel, index))
    }
    assert.ok(nodes(index).some((node) => attrText(node, 'value') === 'query'))
    assert.ok(nodes(index).some((node) => ts.isCallExpression(node) && node.expression.getText(sf) === 'filtered.map'))
    assert.ok(nodes(index).some((node) => attrText(node, 'onClick') === '() => choose(rep)'))
    assert.ok(nodes(index).some((node) => attrText(node, 'onClick') === 'newRepresentative'))
  })
  it('computes onboarding summary from the same displayed file array and review statuses', () => {
    const summary = one(jsxNodes.filter((node) => attrText(node, 'data-testid') === 'representatives-summary-onboarding'), 'files summary')
    const text = summary.getText(sf)
    assert.match(text, /\(selected\?\.files \|\| \[\]\)\.length/)
    assert.match(text, /\.filter\(\(file\) =>/)
    assert.match(text, /file\.reviewStatus \|\| 'APPROVED'/)
    assert.match(text, /status !== 'APPROVED' && status !== 'REJECTED'/)
  })
})
