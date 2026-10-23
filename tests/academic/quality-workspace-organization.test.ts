// حارس تنظيم «مركز الجودة الأكاديمي» إلى سبع مساحات عمل (نمط C) — بنيوي وسلوكي-عقدي:
// ١) الأقسام السبعة بعناوينها وترتيبها وربط aria الكامل، وقسم واحد مفتوح عبر activeWorkspace.
// ٢) كل بطاقة أصلية داخل مساحتها المقصودة (فحص مواضع فعلي في المصدر، لا مجرد وجود).
// ٣) المؤشرات العامة: 12 مؤشرًا من overviewCards نفسها، والافتراضي أربع بطاقات بعينها
//    (برامج نشطة/تحتاج تحسين/توثيق مصادر الأسئلة/طلاب متعثرون — مواضعها الأصلية 1 و2 و4 و6،
//    فأي slice(0, 4) أعمى يُظهر المجموعة الخاطئة ويسقط هنا).
// ٤) أجسام الدوال الـ52 خارج المكوّن الرئيسي ثابتة ببصمات SHA-256 (نص مُطبّع) — ودالة load
//    تُقارن بعد إزالة أسطر حالة العرض المضافة وحدها (setSecondaryLoaded/setSecondaryFailed
//    وعبارة mark داخل catch بالشكل الموثق)؛ أي تغيير آخر في جسمها يسقط الحارس.
// ٥) بصمة نداءات api/fetch الداخلية (38) وبصمة أحداث dispatchEvent (4) بتعابيرها الكاملة.
// ٦) الحالات الأصلية الـ73 كلها موجودة؛ الإضافات محصورة في حالات العرض الخمس الموثقة.
// ٧) الحوارات الـ15 في مواضعها وبأسماء حالات فتحها نفسها (13 inline + 2 standalone).
// ٨) نجاح تحليل TSX عبر ts.transpileModule بـ reportDiagnostics (لا parseDiagnostics).
import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const SOURCE = readFileSync(join(process.cwd(), 'src/components/aact/AdminQualityTab.tsx'), 'utf8')
const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
const sha = (t: string) => createHash('sha256').update(norm(t)).digest('hex')

const sf = ts.createSourceFile('AdminQualityTab.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function fnText(node: ts.Node): string {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    let init: ts.Node = node.initializer
    if (ts.isCallExpression(init) && init.arguments.length) init = init.arguments[0]
    return init.getText(sf)
  }
  return node.getText(sf)
}

// إزالة إضافات حالة العرض الموثقة من جسم load وحده قبل البصمة: أسطر الإسناد المستقلة،
// وعبارات تعليم الفشل داخل catch (قيم الاحتياط نفسها لم تتغير)، مع طيّ شكل catch الناتج.
function canonicalLoad(text: string): string {
  let t = text
  t = t.replace('\n    setSecondaryLoaded(false)', '')
  t = t.replace('\n    setSecondaryFailed({})', '')
  t = t.replace('\n          setSecondaryLoaded(true)', '')
  t = t.replace('setSecondaryFailed((p) => ({ ...p, reviews: true })); ', '')
  t = t.replace('setSecondaryFailed((p) => ({ ...p, readiness: true })); ', '')
  t = t.split('.catch(() => { return { items: [] } })').join('.catch(() => ({ items: [] }))')
  return t
}

function collect() {
  const functions = new Map<string, string>()
  const apiCalls: string[] = []
  const dispatches: string[] = []
  const states: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, sha(node.name.text === 'load' ? canonicalLoad(fnText(node)) : fnText(node)))
    }
    if (ts.isVariableDeclaration(node) && node.name) {
      const init = node.initializer
      if (ts.isIdentifier(node.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || (ts.isCallExpression(init) && init.expression.getText(sf) === 'useCallback'))) {
        functions.set(node.name.text, sha(node.name.text === 'load' ? canonicalLoad(fnText(node)) : fnText(node)))
      }
      if (init && ts.isCallExpression(init) && init.expression.getText(sf).startsWith('useState')) {
        states.push(node.name.getText(sf).replace(/[[\]]/g, '').split(',')[0].trim())
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && (callee.text === 'api' || callee.text === 'fetch')) {
        apiCalls.push(callee.text + ':' + norm(node.getText(sf)))
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatchEvent') {
        dispatches.push(norm(node.getText(sf)))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const digest = (arr: string[]) => createHash('sha256').update(arr.slice().sort().join('\n')).digest('hex')
  return { functions, states, apiDigest: digest(apiCalls), apiCount: apiCalls.length, dispatchDigest: digest(dispatches), dispatchCount: dispatches.length }
}

const BASELINE_FUNCTIONS: Record<string, string> = {
  "metricValue": "f71eea5e925b9cf4108406a4d690ce775258ddbfb4a59c729c0eb0cc998c7cc5",
  "formatSeconds": "e4aa386bf9e77137172a1c2411c022bcda07ec63cf9c95ef0ccfa3b1cbfba5c7",
  "asArray": "41bd09add884a3a456a30d455cc1117a14d0e74afc6c10aa003a76baf36da6f9",
  "asObjectArray": "30e9a440ec2d1bdaee8fe928bbee96584465d0c26460b7e4f2f2f1bd48126890",
  "safeDateLabel": "eff633d9068e16a44c9b4d2d6d21204039c2f3f96289290ae04f6cec7303e60e",
  "load": "17ff04755e025fbf738e7a7e03f6f8b7c5d17b02d3d324107de92f36826c2096",
  "refreshStorageReport": "867c17dd85dd36b4b8714929408b8a7219fb45348cc69b5c635a532bc80b27d9",
  "exportProgramCatalog": "9f7fabd97a8c3973812bfb30725b5e7824b92d1fd94f4b986fec1c560d4aa607",
  "importProgramCatalog": "e81e226ba0ea66917aafc4e3c9be592b5866ab84e068f3dc293d43858295377a",
  "updateReviewStatus": "0b42e84e05e3e154456bc0c4648a061a76b926618f02d3596cf276b2eed41e0f",
  "updateProgramReadiness": "d119327368e917ef3469696edeab1f031a281835d0a2cee09abb2a3cc94052d9",
  "runSuggestedUnits": "40120ab0473dee83b344b864469f21916d732ca431b9a25afa94a4d38677e2e2",
  "suggestUnits": "9030688bff7d4381299a0a0a099521a843711f544b6ee0ea0c9a7d0068fbc558",
  "chooseUnitSuggestionMode": "674554f64014b59526ce88faddc92b1de9c98f6f17d5144c2c9bd83e254dab28",
  "openUnitReview": "87e32947e5d730cdaab3d4584eaee1e8f6678c96dbd639304548e2b477124522",
  "patchUnit": "faadb19fe7601254136032c3d059c5d8baabaf041893cdd5ea08263d1a75e539",
  "addUnit": "b4728f6047a8fdb44ab8c08aebdbe9140d1c76d658f35a7aadc85125b1810a94",
  "deleteUnit": "f5c09fd3ce4a50797d96b72956b0760efd010991cae201fc73ef8d1d69150f6a",
  "confirmDeleteUnit": "b1288f9f47c98b93441d267bb63c00611e953ab5c26f792622d01792e0a37354",
  "openQuestionBank": "1861805547d304acc64e51227e120cf19a1d73711442a5681e3d405abc521d5b",
  "generateQuestionBank": "f0d58c735e387efe95cf6e077123fdb938e8c205993ff0a411471e8ee92a96ec",
  "addManualQuestion": "749c83c56a4e5318cda6430cfee80c56919158ad37ef36217920f6cef9f13e09",
  "importQuestions": "25a350df68857518ea127a758089dcba9149c1f52fbdae2a534c71550a754db9",
  "openExamImport": "6e2db4bef8df5b0bf685fcb906f5967cdd4cdbfa9f5a62c363ecde41eeefd8b0",
  "copyExamQuestionsToBank": "129c9ea782ae4d8dff316c5d027b1d8e873f27224b2d4ed39318357f104dd60c",
  "generateExamFromQuestionBank": "e61f7e5a5e454dea02063289670b996be054e060a5f88879ce45f5bbba4c4233",
  "updateExamGenerationValue": "ef18aaa2bd008c0133ee334db411e1877e331abd10951f8b977236b0d85c629d",
  "submitExamGenerationForm": "22c42b530cba548e9a2ca4abd2e9721dff7184913b632c1e222f88cce429b58e",
  "doGenerate": "ed432c85414a155fb2af864052e180c7c6cc47e10a7018d0697e17dfb11b89c3",
  "updateQuestionBankStatus": "acf90aa80dc40ab15c32503c3d9eda50c41c85d754e08dbf5b642520aca46c6b",
  "loadStudents": "d34e229f01118d012e2f5dc4fb2dedcf898ddd4f1975debd8c73a12db5f16895",
  "loadStudentDetails": "fdb79af25294d68ceec17a0ea61ecfb52675ffa8c8c9c404ce8a83c937881d78",
  "updateStudentAction": "cd01863fa8eb3ec70d68299b76ee1792abe0db1f94f1593621ab5339d56372c8",
  "exportStudentsList": "38aed54dd6e9b905b71278e0cd7e7de84b1b07974e63d118f2bd7648319834e8",
  "resetStudentFilters": "b1a71d7922cba27f3777ea661788d6f24faf7a4fade896d7b10f0cbf16b16406",
  "exportSelectedStudent": "3c2c17fc281c3df3c367068439dc3d5546ec9471e8fb78aa81851af2465a2101",
  "openStudentsManager": "324e22126bff4e70367e477a206e7a9ef2e3c67caa4ec03d2c7519e2880e70ba",
  "loadStudentPreview": "17555bab6eed36a2c36956a5761029d8e935fa588cf6c4dcc930f00fea3474af",
  "openStudentPreview": "2f713baba64481c2b9b61743b97b82de0e369e25a7aa0c1f7542f41e83186726",
  "loadMailStatus": "efef16f5327c73c27f9bb74612d17ef267427e4da4a578c736dbf85ffb323894",
  "openMailStatus": "9bad3a4fe1d436322d6fa5b448d4c9c71c76bb18b511a0d5c311e70d01fb21f0",
  "loadLaunchHealth": "987458b8c0b2409002163a756cda6c09b4e166e3c6babcc2ddb93f5d12ca8afa",
  "openLaunchHealth": "6c59346548ef74863de9ffda5e43bac1548685320158b6abc3737678b4de0bac",
  "loadDailyTasks": "45e22b6e6b331cdcc4d021be97d4a892df584e4e3b87b4f8d281f15d14fca8c5",
  "openDailyTasks": "64f1cafdee207f8c9e8ad4cbdc9e4d15e60717ee9b2c43aec6e33c73f5f57c92",
  "exportLaunchHealthReport": "ab55edf5834c0ec88907cedd0d7539fa0198687181be83a167a8f49f19dd1d0d",
  "sendMailTest": "d5d528df4455cb0a6fb9faf1801a7a064130add285569b1f760886d304dfc132",
  "loadThesisTopics": "0a3ee81b81427c157078ed1571597901e9d2717279f3a4a53980d10fd44eb56b",
  "updateThesisTopicStatus": "20fc4ec1b4022de832039348a351fc8efd6e7f0526e3177d89d1129eab746973",
  "updateThesisTopicRequestStatus": "7e4082cb37b943b156dc94289c77a994ba780b833b6d2840f202b38d5daa772e",
  "openThesisTopicDialog": "03ebfc6feb0ceaf91bc15b482200581c5759b15c28358641a17190ff21ec6194",
  "submitThesisTopicAction": "6bea4d8f334bbccdecfd7460a27ddc5974f0addb9f819012ac6de8a2085e4368"
}
const BASELINE_STATES: string[] = ["catalogBusy", "catalogImportOpen", "catalogImportText", "dailyTasks", "dailyTasksLoading", "dailyTasksOpen", "data", "error", "examGenerationDialog", "examImportApproveNow", "examImportItems", "examImportOpen", "importApproveNow", "importQuestionsOpen", "importText", "launchHealth", "launchHealthLoading", "launchHealthOpen", "loading", "mailStatus", "mailStatusLoading", "mailStatusOpen", "mailTestEmail", "mailTestSending", "manualQuestion", "manualQuestionOpen", "questionBankBusyId", "questionBankItems", "questionBankOpen", "questionBankProgram", "questionBankStats", "readinessBusyId", "readinessItems", "reviewBusyId", "reviewItems", "selectedExamId", "selectedExamQuestionIds", "selectedStudent", "storageReport", "storageReportLoading", "studentBusyId", "studentPaymentFilter", "studentPreview", "studentPreviewLoading", "studentPreviewOpen", "studentPreviewProgramId", "studentPreviewPrograms", "studentProgramFilter", "studentSearch", "studentStatus", "studentThesisFilter", "students", "studentsLoading", "studentsOpen", "thesisGenerateCount", "thesisProgramId", "thesisTopicBusy", "thesisTopicDescription", "thesisTopicDialogOpen", "thesisTopicList", "thesisTopicLoading", "thesisTopicMode", "thesisTopicRequests", "thesisTopicTitle", "unitBusyId", "unitDeleteTarget", "unitGenerationResult", "unitRegenerateDrafts", "unitReviewItems", "unitReviewOpen", "unitReviewProgram", "unitSuggestionConflict", "unitSuggestionModeBusy"]
const API_DIGEST = '62f087a07bb8dd26eb58d5278246e64762aceaff531db9f678dd4ff514d18ac8'
const DISPATCH_DIGEST = '23fea5a336c6ab90eef60656135c298fad22a28f57fc6440b56254e723561529'

const WORKSPACES: Array<{ id: string; title: string; cards: string[] }> = [
  { id: 'curricula', title: 'جاهزية المناهج', cards: ['تجهيز واعتماد المناهج للبرامج المسجل بها'] },
  { id: 'supervision', title: 'مراجعة المشرف الذكي', cards: ['ردود المشرف الذكي التي تحتاج مراجعة', 'أي مشرف ذكي أعطى إجابات ضعيفة؟', 'مؤشرات المشرف الذكي'] },
  { id: 'programs', title: 'تحليل البرامج', cards: ['أي البرامج قوية؟', 'أي تخصص عليه طلب عالي؟', 'جودة البرامج حسب المحتوى والتقييم والدعم', 'متوسطات أكاديمية'] },
  { id: 'content', title: 'سلامة المحتوى والتقييم', cards: ['كتب تحتاج تقوية بنك المعرفة', 'تكرار محتمل في الأسئلة'] },
  { id: 'students', title: 'الطلاب الذين يحتاجون متابعة', cards: ['طلاب يحتاجون متابعة'] },
  { id: 'operations', title: 'سلامة النظام والبيانات', cards: ['حفظ كتالوج البرامج قبل تنظيف قاعدة البيانات', 'تقرير سلامة التخزين'] },
  { id: 'thesis', title: 'عناوين أبحاث التخرج', cards: ['إدارة عناوين بحث التخرج'] },
]

describe('quality workspace organization guard', () => {
  it('TSX transpiles with zero error diagnostics', () => {
    const out = ts.transpileModule(SOURCE, {
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    })
    const errors = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert.equal(errors.length, 0, errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | '))
  })

  it('has the seven workspaces in order with full aria wiring and one-open state', () => {
    assert.ok(SOURCE.includes("useState<'curricula' | 'supervision' | 'programs' | 'content' | 'students' | 'operations' | 'thesis' | null>('curricula')"))
    assert.ok(SOURCE.includes('const toggleWorkspace ='))
    assert.ok(SOURCE.includes("setActiveWorkspace((current) => (current === workspace ? null : workspace))"))
    assert.ok(SOURCE.includes("window.scrollTo({ top: y, behavior: 'auto' })"))
    let prev = -1
    for (const ws of WORKSPACES) {
      const regionIdx = SOURCE.indexOf(`id="quality-ws-${ws.id}"`)
      assert.ok(regionIdx > prev, `workspace ${ws.id} out of order`)
      prev = regionIdx
      assert.ok(SOURCE.includes(`id="quality-ws-${ws.id}-header"`), ws.id)
      assert.ok(SOURCE.includes(`aria-controls="quality-ws-${ws.id}"`), ws.id)
      assert.ok(SOURCE.includes(`aria-expanded={activeWorkspace === '${ws.id}'}`), ws.id)
      assert.ok(SOURCE.includes(`hidden={activeWorkspace !== '${ws.id}'}`), ws.id)
      assert.ok(SOURCE.includes(`onClick={() => toggleWorkspace('${ws.id}')}`), ws.id)
      const headerIdx = SOURCE.indexOf(`id="quality-ws-${ws.id}-header"`)
      assert.ok(SOURCE.slice(headerIdx, regionIdx).includes(ws.title), `title of ${ws.id}`)
      // رأس القسم زر مستقل بلا أزرار إجراءات داخله: بين زر الرأس ومنطقته لا يوجد onClick آخر
      const headerBlock = SOURCE.slice(headerIdx, regionIdx)
      assert.equal((headerBlock.match(/onClick/g) || []).length, 1, `header of ${ws.id} carries extra actions`)
    }
  })

  it('places every original card inside its intended workspace region', () => {
    const starts = WORKSPACES.map((ws) => SOURCE.indexOf(`id="quality-ws-${ws.id}"`))
    const dialogsIdx = SOURCE.indexOf('<Dialog open={dailyTasksOpen}')
    assert.ok(dialogsIdx > 0)
    WORKSPACES.forEach((ws, i) => {
      const end = i + 1 < WORKSPACES.length ? starts[i + 1] : dialogsIdx
      for (const card of ws.cards) {
        const idx = SOURCE.indexOf(card)
        assert.ok(idx > starts[i] && idx < end, `card «${card}» is not inside workspace ${ws.id}`)
      }
    })
  })

  it('keeps all 12 overview indicators and defaults to the four named ones by label', () => {
    const start = SOURCE.indexOf('const overviewCards = [')
    const end = SOURCE.indexOf(']', start)
    const arr = SOURCE.slice(start, end)
    assert.equal((arr.match(/label: '/g) || []).length, 12)
    for (const label of ['برامج نشطة', 'تحتاج تحسين', 'امتحانات جاهزة', 'توثيق مصادر الأسئلة', 'اكتمال القياس', 'طلاب متعثرون', 'نسبة النجاح', 'نسبة الاعتراضات', 'متوسط زمن الرد', 'ردود مشرف ضعيفة', 'تغطية ذاكرة المشرف', 'مهارات صغيرة']) {
      assert.ok(arr.includes(`label: '${label}'`), label)
    }
    assert.ok(SOURCE.includes("const DEFAULT_OVERVIEW_LABELS = ['برامج نشطة', 'تحتاج تحسين', 'توثيق مصادر الأسئلة', 'طلاب متعثرون']"))
    assert.ok(SOURCE.includes('showAllIndicators ? overviewCards : overviewCards.filter((m) => DEFAULT_OVERVIEW_LABELS.includes(m.label))'))
    assert.ok(SOURCE.includes('{visibleOverviewCards.map((m) => ('))
    assert.ok(SOURCE.includes("'عرض جميع المؤشرات'"))
    assert.ok(SOURCE.includes("'إخفاء المؤشرات الإضافية'"))
  })

  it('keeps the six header actions and the collapsible weekly recommendations', () => {
    for (const label of ['مهام الإدارة اليوم', 'إدارة الطلاب', 'معاينة تجربة الطالب', 'حالة البريد', 'مراقبة الإطلاق', 'تحديث المؤشرات']) {
      assert.ok(SOURCE.includes(label), label)
    }
    assert.ok(SOURCE.includes('توصيات تشغيل الجودة هذا الأسبوع'))
    assert.ok(SOURCE.includes('aria-controls="quality-recommendations"'))
    assert.ok(SOURCE.includes('id="quality-recommendations" hidden={!recommendationsOpen}'))
    assert.ok(SOURCE.includes('data.recommendations.map((r, i) => ('))
    // التوصيات خارج كل مساحات العمل: قبل أول قسم
    assert.ok(SOURCE.indexOf('id="quality-recommendations"') < SOURCE.indexOf('id="quality-ws-curricula"'))
  })

  it('keeps all 15 dialogs mounted in place with their original open-state bindings', () => {
    assert.equal((SOURCE.match(/<Dialog open=/g) || []).length, 13)
    assert.equal((SOURCE.match(/^\s+open=\{/gm) || []).length, 2)
    for (const name of ['dailyTasksOpen', 'launchHealthOpen', 'mailStatusOpen', 'studentPreviewOpen', 'studentsOpen', 'thesisTopicDialogOpen', 'catalogImportOpen', 'questionBankOpen', 'examImportOpen', 'manualQuestionOpen', 'importQuestionsOpen', 'unitReviewOpen', 'examGenerationDialog', 'unitSuggestionConflict', 'unitDeleteTarget']) {
      assert.ok(SOURCE.includes(`open={${name}`) || SOURCE.includes(`open={!!${name}`), name)
    }
    // الحوارات بعد آخر مساحة عمل — لم تنتقل إلى داخل الأقسام المخفية
    assert.ok(SOURCE.indexOf('<Dialog open={dailyTasksOpen}') > SOURCE.indexOf('id="quality-ws-thesis"'))
  })

  it('renders workspace summaries as expressions, never literal ${} text', () => {
    // خطأ الجولة الأولى: ثلاث ملخصات كُتبت كنص حرفي يبدأ بـ ${ فظهرت علامة $ للمستخدم.
    assert.ok(!/>\$\{/.test(SOURCE), 'a summary is rendered as literal ${} text')
    assert.ok(SOURCE.includes('{`${data.programs.length} برنامج في التقرير'))
    assert.ok(SOURCE.includes('{`${data.weakBooks.length} كتاب يحتاج تقوية'))
    assert.ok(SOURCE.includes('{`${data.atRiskStudents.length} طالب يحتاج متابعة'))
  })

  it('keeps secondary-load honesty: loading/failure display states gate the summaries', () => {
    assert.ok(SOURCE.includes('const [secondaryLoaded, setSecondaryLoaded] = useState(false)'))
    assert.ok(SOURCE.includes('جارٍ تحميل بيانات الجاهزية…'))
    assert.ok(SOURCE.includes('تعذّر تحميل بيانات الجاهزية'))
    assert.ok(SOURCE.includes('جارٍ تحميل البلاغات…'))
    assert.ok(SOURCE.includes('تعذّر تحميل البلاغات'))
    assert.ok(SOURCE.includes("'تقرير التخزين غير محمّل'"))
  })

  it('freezes all 52 non-component function bodies (load after its documented display-state additions)', () => {
    const { functions } = collect()
    const names = [...functions.keys()].filter((n) => n !== 'AdminQualityTab')
    assert.deepEqual(names.slice().sort(), Object.keys(BASELINE_FUNCTIONS).slice().sort())
    for (const [name, hash] of Object.entries(BASELINE_FUNCTIONS)) {
      assert.equal(functions.get(name), hash, `function body changed: ${name}`)
    }
  })

  it('freezes the full API call surface and the aact-admin-tab event payloads', () => {
    const { apiDigest, apiCount, dispatchDigest, dispatchCount } = collect()
    assert.equal(apiCount, 38)
    assert.equal(apiDigest, API_DIGEST)
    assert.equal(dispatchCount, 4)
    assert.equal(dispatchDigest, DISPATCH_DIGEST)
    for (const frag of ["tab: 'books'", "section: 'exams'", "section: 'books'", "section: 'knowledge'", "subSection: 'add'"]) {
      assert.ok(SOURCE.includes(frag), frag)
    }
  })

  it('loses no React state and adds only the five documented display states', () => {
    const { states } = collect()
    for (const name of BASELINE_STATES) assert.ok(states.includes(name), `state lost: ${name}`)
    const added = states.filter((s) => !BASELINE_STATES.includes(s))
    assert.deepEqual(added.slice().sort(), ['activeWorkspace', 'recommendationsOpen', 'secondaryFailed', 'secondaryLoaded', 'showAllIndicators'])
  })
})
