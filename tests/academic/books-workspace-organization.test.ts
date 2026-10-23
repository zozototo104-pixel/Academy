import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Guard for the Books & Exams workspace organization (presentation only).
// Recorded from AdminBooks.tsx on dev/2026-10-23 before restructuring: the protected
// academic logic is pinned by body hashes and by the exact API-call surface, so any
// silent logic change fails here even if the visible text still "looks" organized.
const SOURCE = readFileSync(resolve(process.cwd(), 'src/components/aact/AdminBooks.tsx'), 'utf8')

const digest = (text: string) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')

const ORIGINAL_FUNCTION_HASHES: Record<string, string> = {
  isCatalogLikeUiLink: '93f7b3faf4202e69bb9eb9d1d7da1a508fbee90b88acc5e76c847c80e37419f4',
  bookNeedsReadableSource: '7f1883f10d3d63aa91c3037b31357e12215722e0c00ba727a76967e3fac84657',
  loadProgramData: 'c8100488c57894107b24c1b9d50b2d661097442b8f8247409fef88ab5c69d9e9',
  addBook: '4700faf06c1d307a54615f61b573370e64c79f519e25cb51de6dfe5dcd796599',
  updateBookSource: '5caaafdc9ebe990b2c4d36cb3f2e415bfc662929e4ec816e7caca5122271cd2f',
  deleteBook: '40b8c4120c1c782b73206f9998512221d36fc7b3d523e6d6266d13ea1e480d92',
  refreshProgramReadiness: '4bcfeaf821451def388c4916edb0936aea32d71c97d29a4d6e9752cbcbdd2fd8',
  suggest: 'badc7e266c544800eb1267d3d21901d3e2490f13add7025389f8ab81b2cc671a',
}
const ORIGINAL_API_CALL_COUNT = 76
// بصمة سطح النداءات من تعبير الاستدعاء الكامل (المسار + الخيارات: الطريقة والجسم والترويسات)،
// لا من العنوان وحده — أي تغيير في عقد أي طلب يغيّر البصمة.
const ORIGINAL_API_DIGEST = '19ff4e867fb726a8aa3df32bbd0108f316211832cf5c79ba9644f1527b4ff613'

function parseSource() {
  return ts.createSourceFile('AdminBooks.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function functionHashes(): Record<string, string> {
  const sf = parseSource()
  const wanted = new Set(Object.keys(ORIGINAL_FUNCTION_HASHES))
  const hashes: Record<string, string> = {}
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const name = node.name.getText(sf)
      if (wanted.has(name)) {
        let fn: ts.Node = node.initializer
        if (ts.isCallExpression(fn) && fn.arguments[0] && (ts.isArrowFunction(fn.arguments[0]) || ts.isFunctionExpression(fn.arguments[0]))) {
          fn = fn.arguments[0]
        }
        hashes[name] = digest(fn.getText(sf))
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.getText(sf))) {
      hashes[node.name.getText(sf)] = digest(node.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hashes
}

function apiSurface(): { count: number; digest: string } {
  const sf = parseSource()
  const calls: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf)
      if (callee === 'api' || callee === 'fetch') {
        calls.push(callee + ':' + node.getText(sf))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  calls.sort()
  return { count: calls.length, digest: digest(calls.join('\n')) }
}

function currentBooksSlice(): string {
  const start = SOURCE.indexOf('<TabsContent value="current"')
  const end = SOURCE.indexOf('<TabsContent value="ai"', start)
  assert.ok(start >= 0 && end > start, 'current books TabsContent slice must exist')
  return SOURCE.slice(start, end)
}

describe('books workspace organization guard', () => {
  it('AdminBooks.tsx transpiles without syntax errors', () => {
    const out = ts.transpileModule(SOURCE, {
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    })
    const errors = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert.equal(errors.length, 0, errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '))
  })

  it('protected academic function bodies are byte-equivalent (whitespace-normalized)', () => {
    assert.deepEqual(functionHashes(), ORIGINAL_FUNCTION_HASHES)
  })

  it('the API/fetch call surface is unchanged (full call expressions: path, method, body, headers)', () => {
    const surface = apiSurface()
    assert.equal(surface.count, ORIGINAL_API_CALL_COUNT)
    assert.equal(surface.digest, ORIGINAL_API_DIGEST)
  })

  it('program selection and its data reset stay wired', () => {
    assert.ok(SOURCE.includes('onValueChange={(v) => { setProgramId(v); setSuggestions([]); loadProgramData(v) }}'))
    assert.ok(SOURCE.includes('setProgramReadiness(null)'))
    assert.ok(SOURCE.includes("useState('overview')") || SOURCE.includes('useState("overview")'))
  })

  it('all eight workspace tabs keep their original values', () => {
    for (const value of ['overview', 'books', 'knowledge', 'units', 'guides', 'assignments', 'grading', 'exams']) {
      assert.ok(SOURCE.includes(`<TabsTrigger value="${value}"`), `missing workspace tab ${value}`)
    }
    assert.ok(SOURCE.includes('id="admin-books-workspace"'))
  })

  it('the external navigation contract aact-admin-books-target is intact', () => {
    assert.ok(SOURCE.includes("window.addEventListener('aact-admin-books-target'"))
    assert.ok(SOURCE.includes("window.removeEventListener('aact-admin-books-target'"))
    assert.ok(SOURCE.includes("section === 'add' ? 'books' : section"))
    assert.ok(SOURCE.includes("setBooksSubTab(String(detail.subSection || 'current'))"))
  })

  it('the three books subtabs keep their original values', () => {
    for (const value of ['current', 'add', 'ai']) {
      assert.ok(SOURCE.includes(`<TabsTrigger value="${value}"`), `missing books subtab ${value}`)
    }
    assert.ok(SOURCE.includes('onClick={suggest}'))
  })

  it('readiness card collapses with its summary (status + registration + refresh) always visible', () => {
    const detailsAt = SOURCE.indexOf('id="program-readiness-details"')
    assert.ok(detailsAt > 0)
    assert.ok(SOURCE.includes('hidden={!readinessOpen}'))
    assert.ok(SOURCE.includes('aria-controls="program-readiness-details"'))
    assert.ok(SOURCE.includes('onClick={refreshProgramReadiness}'))
    // summary facts live in the header, before the collapsible region
    assert.ok(SOURCE.indexOf('programReadiness.isCurriculumReady') < detailsAt)
    assert.ok(SOURCE.indexOf('programReadiness.registrationStatus') < detailsAt)
    // details (counts + checks) live inside the collapsible region
    assert.ok(SOURCE.indexOf('programReadiness.counts.books') > detailsAt)
    assert.ok(SOURCE.indexOf('programReadiness.checks') > detailsAt)
  })

  it('current list renders the locally filtered books, not the raw array', () => {
    const slice = currentBooksSlice()
    assert.ok(slice.includes('filteredBooks.map((b, i)'))
    assert.ok(!slice.includes('books.map((b, i)'))
    assert.ok(slice.includes('value={bookSearch}'))
    assert.ok(slice.includes('value="NEEDS_SOURCE"'))
    assert.ok(slice.includes('مسح الفلاتر'))
    assert.ok(slice.includes('لا توجد نتائج مطابقة'))
    // display-only region: no network calls are introduced by search/filters/expansion
    assert.ok(!slice.includes('api('))
    assert.ok(!slice.includes('fetch('))
  })

  it('one book expands at a time through an accessible toggle, details stay mounted but hidden', () => {
    const slice = currentBooksSlice()
    assert.ok(slice.includes('aria-expanded={expandedBookId === b.id}'))
    assert.ok(slice.includes('aria-controls={`book-details-${b.id}`}'))
    assert.ok(slice.includes('hidden={expandedBookId !== b.id}'))
    assert.ok(slice.includes('عرض التفاصيل'))
    assert.ok(slice.includes('إخفاء التفاصيل'))
    assert.ok(slice.includes('setExpandedBookId((cur) => (cur === b.id ? null : b.id))'))
  })

  it('book details keep every original field and action, with delete inside the details', () => {
    const slice = currentBooksSlice()
    const detailsAt = slice.indexOf('book-details-${b.id}')
    assert.ok(detailsAt > 0)
    for (const marker of [
      '{b.description &&',
      'سياسة المستوى:',
      'LINK_READ_META[b.linkReadStatus]',
      '/api/books/${b.id}/download',
      'value={sourceLinks[b.id] || \'\'}',
      'type="file"',
      'updateBookSource(b)',
      'bookNeedsReadableSource(b)',
    ]) {
      assert.ok(slice.includes(marker), `missing detail marker: ${marker}`)
    }
    assert.ok(slice.indexOf('deleteBook(b.id)') > detailsAt, 'delete must live inside the expanded details, not the summary header')
  })

  it('selection termination is real state clearing, not a hidden derivation', () => {
    assert.ok(SOURCE.includes('!filteredBooks.some((b) => b.id === expandedBookId)'))
    assert.ok(SOURCE.includes('setExpandedBookId(null)'))
  })

  it('switching the program terminates the open book immediately, before any load result', () => {
    // يُصفّر الاختيار في رسمة التبديل نفسها (نمط ضبط الحالة أثناء الرسم)، لا بعد الاستجابة:
    // حتى لو فشل تحميل البرنامج الجديد وبقيت كتب القديم محمّلة (سلوك سابق في
    // loadProgramData)، لا يجوز أن يبقى تفصيل كتاب قديم مختارًا تحت البرنامج الجديد.
    assert.ok(SOURCE.includes('if (expandedBookProgramId !== programId)'))
    assert.ok(SOURCE.includes('setExpandedBookProgramId(programId)'))
  })
})
