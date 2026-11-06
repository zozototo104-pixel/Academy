import { beforeEach, describe, expect, it, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
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
  // PR #188: preserve total from paginated knowledge-bank response; count alone is page size.
  loadProgramData: '6b12d54037f8095e36be378ef3db2d1f3db8e9979359d946e8973339c7a976f4',
  addBook: '4700faf06c1d307a54615f61b573370e64c79f519e25cb51de6dfe5dcd796599',
  updateBookSource: '5caaafdc9ebe990b2c4d36cb3f2e415bfc662929e4ec816e7caca5122271cd2f',
  deleteBook: '40b8c4120c1c782b73206f9998512221d36fc7b3d523e6d6266d13ea1e480d92',
  refreshProgramReadiness: '4bcfeaf821451def388c4916edb0936aea32d71c97d29a4d6e9752cbcbdd2fd8',
  suggest: 'badc7e266c544800eb1267d3d21901d3e2490f13add7025389f8ab81b2cc671a',
}
const ORIGINAL_API_CALL_COUNT = 81 // Existing 80 reviewed calls plus the admin semester/student roster GET
// بصمة سطح النداءات من تعبير الاستدعاء الكامل (المسار + الخيارات: الطريقة والجسم والترويسات)،
// لا من العنوان وحده — أي تغيير في عقد أي طلب يغيّر البصمة.
// تحديث مقصود 2026-10-25 (PR #136): النداء 77 الوحيد المضاف هو تحليل الذكاء
// للأدمن (POST /api/supervisor/assignments {action:'analyze'}) — مسودة فقط، بلا حفظ.
// تم التحقق أن النداءات 76 القديمة لم تتغير ولم يُحذف منها شيء.
// تحديث مقصود 2026-10-25-a (موعد الواجب الثابت + فيديوهات): العدد بقي 77،
// ونداء واحد فقط تغيّر جسمه — إضافة واجب مقترح مباشرة (POST /api/admin/assignments)
// صار يرسل dueDays: null و dueAt: null بدل موعد مقترح من الذكاء؛ باقي النداءات لم تُمسّ.
// تحديث مقصود 2026-10-25-f (PR #141 إعادة تحقق الختم): العدد صار 78،
// والنداء الوحيد المضاف هو إعادة التحقق (POST /api/admin/units/[id]/questions/reverify-grounding)
// — تم التحقق بمقارنة سطح النداءات مع main: إضافة واحدة فقط، ولا حذف ولا تعديل لأي نداء قديم،
// وأجسام الدوال المحمية ما زالت مطابقة (الاختبار الأول ما زال ينجح).
// تحديث مقصود 2026-10-25-g (إصلاح حلقة إعادة التحقق): العدد بقي 78،
// وتعبير نداء واحد فقط تغيّر — نوع استجابة نداء إعادة التحقق نفسه (حقول التفصيل
// الجديدة: skippedNoSource/skippedNoProvenance/skippedOcr/alreadyRechecked/verifiableRemaining)؛
// المسار والطريقة والجسم لم تُمسّ، ولا نداء مضاف ولا محذوف.
// تحديث مقصود 2026-10-31 (PR #164، حارس تغطية الفهرس): العدد بقي 79،
// وتعبير نداء واحد فقط تغيّر — نداء اعتماد الفهرس نفسه
// (POST /api/admin/books/[id]/outline/approve) صار جسمه متغيّراً
// (JSON.stringify(body)) بدل الثابت الفارغ، لأن المحاولة الأولى ترسل {}
// وعند رفض الحارس (أقسام فوق 80 صفحة) تُعاد المحاولة بجسم التجاوز الموثّق
// {overrideOversized, overrideReason} بعد تأكيد المشرف وكتابة السبب.
// تم التحقق بمقارنة سطح النداءات مع main باستخراج الحارس نفسه:
// 79 نداءً في النسختين، وتعبير واحد مختلف فقط، ولا نداء مضاف ولا محذوف.
// Reviewed PR #165 change: the existing POST /api/admin/assignments suggestion
// save includes unitId and sourceKnowledgeIds, so the original evidence is
// not silently discarded; the apply-to-form path carries the same IDs.
// No endpoint, HTTP method, or call count changed. The changed payload is
// guarded independently in tests/assignments/assignment-due-video-guard.test.ts.
// Reviewed PR #168: per-unit assignment generation changes the suggestion calls.
// تحديث مقصود 2026-11-01 (إصلاحات مراجعة PR #168): العدد بقي 80، وتعبيرا
// نداءين فقط تغيّرا — نداءا اقتراح الواجبات (كتالوج GET والوليد POST) أضيف
// إليهما خيار signal لربطهما بـAbortController الخاص بعملية التوليد، حتى
// تُلغى الطلبات القديمة عند تغيير البرنامج أو الفصل. لا نقطة نهاية ولا
// طريقة ولا جسم تغيّر. السلوك مثبّت في
// tests/assignments/assignment-due-video-guard.test.ts و
// tests/assignments/assignment-suggest-behavior.test.ts.
// PR #188: the existing outline approval POST now also sends a report-bound
// acknowledgeCoverage/acknowledgmentKey pair; endpoint and call count stay
// unchanged. This digest pins the reviewed contract; separate assertions below
// ensure the new acknowledgment is never sent before the admin confirms it.
// Keep this declaration outside comments so TypeScript can validate the guard.
const ORIGINAL_API_DIGEST = '06cd5c330f532a607bf472385424563049691648756fc0047abf598ff4d1c29d'

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
  // Only the new review-only DELETE call is exempt from the 78-call frozen baseline.
  const rejectionCalls = calls.filter((call) => call.includes('outline/sections/${sectionId}') && call.includes("method: 'DELETE'"))
  assert.equal(rejectionCalls.length, 1, 'expected exactly one reviewed outline rejection call')
  const rosterCalls = calls.filter((call) => call.includes('/api/supervisor/assignments?mode=roster&programId=') && call.includes('&semester=') && call.includes('encodeURIComponent(cursor)'))
  assert.equal(rosterCalls.length, 1, 'expected exactly one reviewed admin roster GET')
  const protectedCalls = calls.filter((call) => !rejectionCalls.includes(call) && !rosterCalls.includes(call)).sort()
  return { count: calls.length, digest: digest(protectedCalls.join('\n')) }
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

  it('the knowledge-bank total uses full pagination count while retaining the old fallback', () => {
    const sf = SOURCE.slice(SOURCE.indexOf('  const loadProgramData = useCallback('),
      SOURCE.indexOf('  const hasActiveExamGenerationJob = useMemo('))
    assert.ok(sf.includes('setKnowledgeTotalCount(k.total ?? k.count ?? 0)'),
      'the full count comes from total, then safely falls back to count on old responses')
    assert.ok(sf.includes('if (latestProgramLoadRef.current !== loadToken) return'),
      'stale program responses must not overwrite the selected program')
  })

  it('the API/fetch call surface is unchanged (full call expressions: path, method, body, headers)', () => {
    const surface = apiSurface()
    assert.equal(surface.count, ORIGINAL_API_CALL_COUNT)
    assert.equal(surface.digest, ORIGINAL_API_DIGEST)
  })

  it('program selection and its data reset stay wired', () => {
    assert.ok(SOURCE.includes(`onValueChange={(v) => { invalidateAssignmentGeneration(); setSuggestingAssignments(false); setAssignmentSuggestions([]); setAssignmentSuggestionProgress(''); setProgramId(v); setSuggestions([]); loadProgramData(v) }}`))
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

  it('oversized outline approval uses Academy dialogs, preserves the server guard and its documented payload', () => {
    const start = SOURCE.indexOf('  const approveBookOutline = async')
    const end = SOURCE.indexOf('  const loadOutlineDebug = async', start)
    assert.ok(start >= 0 && end > start, 'outline approval flow remains present')
    const flow = SOURCE.slice(start, end)
    assert.ok(!flow.includes('window.confirm(') && !flow.includes('window.prompt('), 'browser system prompts must not be used')
    assert.ok(flow.includes("error?.code === 'OUTLINE_OVERSIZED_SECTIONS' && !overrideReason"), 'only the oversized guard may open the documented override flow')
    assert.ok(flow.includes('const result = await attempt({'), 'single server-guarded approval endpoint remains the source of truth')
    assert.ok(flow.includes('...(overrideReason ? { overrideOversized: true, overrideReason } : {})'),
      'oversized override must only carry the explicitly documented reason')
    assert.ok(flow.includes('...(acknowledgmentKey ? { acknowledgeCoverage: true, acknowledgmentKey } : {})'),
      'missing-page acknowledgment must carry the exact report key')
    assert.ok(flow.includes("error?.code === 'OUTLINE_REVIEW_REQUIRED'"),
      'coverage review is opened only in response to the server rejection')
    assert.ok(flow.includes('outlineCoverageAcksRef.current[bookId] = key') &&
      flow.includes('if (confirmed)') && flow.includes('await approveBookOutline(bookId, overrideReason)'),
      'only confirmed admin consent may trigger the acknowledgment retry')
    assert.ok(flow.includes('reason.length < 3'), 'documented reason must be validated before submission')
    assert.ok(SOURCE.includes("outlineApprovalDialog.stage === 'warning'"), 'warning is an in-platform stage')
    assert.ok(SOURCE.includes("outlineApprovalDialog.stage === 'reason'") || SOURCE.includes("stage: 'reason'"), 'reason entry is an in-platform stage')
    assert.ok(SOURCE.includes('outlineApprovalDialog.blocked.slice(0, 4)'), 'actual oversized sections must be displayed')
    assert.ok(SOURCE.includes('onClick={() => void submitDocumentedOutlineOverride()}'), 'documented override action remains wired')
    assert.ok(SOURCE.includes('void buildOutlineForBook(bookId)'), 'rebuild option remains functional')
    assert.ok(SOURCE.includes('aria-invalid={!!outlineApprovalDialog.error}'), 'invalid reasons are announced in the modal')
    const approvalRoute = readFileSync(resolve(process.cwd(),
      'src/app/api/admin/books/[id]/outline/approve/route.ts'), 'utf8')
    assert.ok(approvalRoute.includes("code: 'OUTLINE_REVIEW_REQUIRED'") &&
      approvalRoute.includes('body?.acknowledgeCoverage !== true || body?.acknowledgmentKey !== acknowledgmentKey'),
      'the server must reject approvals without explicit acknowledgment of the exact report')
    assert.ok(approvalRoute.includes("code: 'OUTLINE_INCOMPLETE_PAGE_RANGES'"),
      'acknowledging gaps must not bypass unknown chapter boundaries')
  })

  it('assignment grading groups every student and never silently cuts off 200 submissions', () => {
    const endpoint = readFileSync(resolve(process.cwd(), 'src/app/api/admin/assignments/route.ts'), 'utf8')
    const start = endpoint.indexOf('// GET /api/admin/assignments?programId=xxx')
    const end = endpoint.indexOf('// POST /api/admin/assignments', start)
    assert.ok(start >= 0 && end > start)
    const query = endpoint.slice(start, end)
    assert.ok(!query.includes('take: 200'), 'the API must not drop older submissions from the student list')
    assert.ok(query.includes('submissions: {') && query.includes('submittedAt'), 'all submissions remain available')
    assert.ok(SOURCE.includes('const groupedGradingQueue = useMemo'), 'the UI must group grading records by student')
    assert.ok(SOURCE.includes('const pagedGradingGroups = pageItems(groupedGradingQueue'), 'pagination applies to student groups')
    assert.ok(SOURCE.includes('<details key={student.studentId}'), 'student submissions must open inside the student card')
  })

  it('book index warnings show Arabic explanations instead of raw audit JSON', () => {
    assert.ok(SOURCE.includes("warning.startsWith('OUTLINE_OVERSIZED_OVERRIDE:')"), 'documented override is decoded for administrators')
    assert.ok(SOURCE.includes('تم اعتماد استثناء موثّق للأقسام الطويلة'), 'human-readable override text is visible')
    assert.ok(SOURCE.includes("warning.startsWith('OUTLINE_')"), 'internal structured metadata is not rendered as raw text')
    assert.ok(SOURCE.includes("w.startsWith('OUTLINE_SUBHEADING:')"), 'original article subheadings still render separately')
    assert.ok(SOURCE.includes('سبب المشرف: ${reason}'), 'supervisor rationale remains readable without exposing internal IDs')
    assert.ok(!SOURCE.includes('⚠ {warning.startsWith'), 'audit code is not rendered directly as a warning')
  })
})

// Behavioural integration checks for the actual per-unit generation API.
// The mock transaction supports rollback, including a simulated failed guide write.
let generatedUnit: any
let generatedGuide: any
let generatedJob: any
let failGuidePersist = false
let generationCalls = 0
const citedContent = [{ heading: 'موضوع', body: 'شرح من المصدر', sourceKnowledgeIds: ['kb-1'], sourceChunkIndexes: [0] }]

const unitDbMock: any = {
  unit: {
    findUnique: async () => generatedUnit,
    update: async ({ data }: any) => {
      generatedUnit = { ...generatedUnit, ...data, generationVersion: generatedUnit.generationVersion + data.generationVersion.increment }
      return { ...generatedUnit }
    },
  },
  programStudyGuide: {
    findFirst: async () => generatedGuide,
    create: async ({ data }: any) => {
      if (failGuidePersist) throw new Error('SIMULATED_GUIDE_WRITE_FAILURE')
      generatedGuide = { id: 'guide-1', ...data }
      return { ...generatedGuide }
    },
    update: async ({ data }: any) => {
      if (failGuidePersist) throw new Error('SIMULATED_GUIDE_WRITE_FAILURE')
      generatedGuide = { ...generatedGuide, ...data }
      return { ...generatedGuide }
    },
  },
  unitGenerationJob: {
    findFirst: async () => generatedJob?.status === 'RUNNING' ? generatedJob : null,
    create: async ({ data }: any) => {
      generatedJob = { id: 'job-1', ...data }
      return { id: generatedJob.id }
    },
    update: async ({ data }: any) => {
      generatedJob = { ...generatedJob, ...data }
      return { ...generatedJob }
    },
  },
  bookChunk: {
    findMany: async () => [{ id: 'chunk-1', index: 0, pageStart: 1, pageEnd: 2, headingPath: 'موضوع', text: 'النص' }],
  },
  bookKnowledgeItem: {
    findMany: async () => [{ id: 'kb-1', category: 'CONCEPT', title: 'المفهوم', summary: 'الفكرة', chunkId: 'chunk-1' }],
  },
}
unitDbMock.$transaction = async (work: (tx: any) => Promise<any>) => {
  const before = structuredClone({ generatedUnit, generatedGuide, generatedJob })
  try {
    return await work(unitDbMock)
  } catch (error) {
    generatedUnit = before.generatedUnit
    generatedGuide = before.generatedGuide
    generatedJob = before.generatedJob
    throw error
  }
}
mock.module('@/lib/db', () => ({ db: unitDbMock }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/outline-units', () => ({
  generateUnitContentWithAi: async () => {
    generationCalls++
    return { summary: 'شرح جديد', objectives: ['هدف'], content: citedContent }
  },
  buildUnitStudyGuideDraft: () => ({
    title: 'دليل', overview: 'ملخص', objectives: ['هدف'],
    keyTerms: ['مصطلح'], sections: [{ title: 'قسم موثق', sourceKnowledgeIds: ['kb-1'] }],
    activities: [], discussionQuestions: [], sourceKnowledgeIds: ['kb-1'],
  }),
  validateStudyGuideSources: (ids: string[], permitted: string[]) => {
    if (!ids.length || ids.some((id) => !permitted.includes(id))) throw new Error('BAD_STUDY_GUIDE_SOURCES')
    return ids
  },
  providerUnavailableStatus: () => false,
}))
const outlineGeneration = await import('@/app/api/admin/program-units/[unitId]/generate/route')

async function generateOneUnit(body: Record<string, unknown> = {}) {
  return outlineGeneration.POST(
    new NextRequest('https://academy.test/api/admin/program-units/unit-1/generate', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ unitId: 'unit-1' }) },
  )
}

describe('unit content + sourced study guide atomic persistence', () => {
  beforeEach(() => {
    generatedUnit = {
      id: 'unit-1', programId: 'program-1', title: 'الوحدة الأولى',
      status: 'DRAFT', semester: 1, order: 1,
      summary: 'شرح قديم', content: JSON.stringify(citedContent),
      objectives: '[]', generationVersion: 3,
      sourceBookId: 'book-1', outlineSectionId: 'section-1',
      chunkStartIndex: 0, chunkEndIndex: 0,
      program: { id: 'program-1', titleAr: 'برنامج تجريبي', titleEn: '' },
    }
    generatedGuide = null
    generatedJob = null
    failGuidePersist = false
    generationCalls = 0
  })

  test('missing study guide is restored without re-generating existing content', async () => {
    const before = { ...generatedUnit }
    const response = await generateOneUnit()
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.skipped).toBeUndefined()
    expect(payload.repairedGuideOnly).toBe(true)
    expect(generationCalls).toBe(0)
    expect(generatedUnit).toEqual(before)
    expect(generatedGuide.sourceKnowledgeIds).toBe('["kb-1"]')
    expect(generatedJob.phase).toBe('GUIDE')
    expect(generatedJob.status).toBe('COMPLETED')
  })

  test('empty guide evidence is repaired without touching the existing unit', async () => {
    generatedGuide = { id: 'guide-1', sourceKnowledgeIds: '[]', sections: '[]' }
    const before = { ...generatedUnit }
    expect(outlineGeneration.hasCompleteUnitArtifacts(citedContent, generatedGuide)).toBe(false)
    const response = await generateOneUnit()
    expect(response.status).toBe(200)
    expect((await response.json()).repairedGuideOnly).toBe(true)
    expect(generationCalls).toBe(0)
    expect(generatedUnit).toEqual(before)
    expect(generatedGuide.sourceKnowledgeIds).toBe('["kb-1"]')
  })

  test('complete referenced content and sourced guide skip safely', async () => {
    generatedGuide = { id: 'guide-1', sourceKnowledgeIds: '["kb-1"]', sections: '[{"title":"قسم موثق"}]' }
    expect(outlineGeneration.hasCompleteUnitArtifacts(citedContent, generatedGuide)).toBe(true)
    const response = await generateOneUnit()
    expect((await response.json()).skipped).toBe('UNIT_ALREADY_HAS_REFERENCED_CONTENT')
    expect(generationCalls).toBe(0)
    expect(generatedUnit.generationVersion).toBe(3)
    expect(generatedJob).toBeNull()
  })

  test('guide repair failure leaves existing content and version untouched', async () => {
    failGuidePersist = true
    const before = { ...generatedUnit }
    const response = await generateOneUnit()
    expect(response.status).toBe(500)
    expect(generationCalls).toBe(0)
    expect(generatedUnit).toEqual(before)
    expect(generatedGuide).toBeNull()
    expect(generatedJob.status).toBe('FAILED')
  })

  test('force explicitly regenerates both content and guide', async () => {
    const response = await generateOneUnit({ force: true })
    expect(response.status).toBe(200)
    expect((await response.json()).repairedGuideOnly).toBe(false)
    expect(generationCalls).toBe(1)
    expect(generatedUnit.summary).toBe('شرح جديد')
    expect(generatedUnit.generationVersion).toBe(4)
    expect(generatedGuide.sourceKnowledgeIds).toBe('["kb-1"]')
  })

  test('absent referenced content still uses full content generation', async () => {
    generatedUnit.content = '[]'
    const response = await generateOneUnit()
    expect(response.status).toBe(200)
    expect((await response.json()).repairedGuideOnly).toBe(false)
    expect(generationCalls).toBe(1)
    expect(generatedUnit.generationVersion).toBe(4)
  })

  test('failed full regeneration rolls back content and version atomically', async () => {
    failGuidePersist = true
    const before = { ...generatedUnit }
    const response = await generateOneUnit({ force: true })
    expect(response.status).toBe(500)
    expect(generationCalls).toBe(1)
    expect(generatedUnit).toEqual(before)
    expect(generatedGuide).toBeNull()
    expect(generatedJob.status).toBe('FAILED')
  })
})

