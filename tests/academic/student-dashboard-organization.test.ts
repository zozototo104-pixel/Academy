import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/DashboardView.tsx')
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
  throw new Error(`Unclosed body for: ${name}`)
}

const requireAll = (text: string, needles: string[]) => {
  for (const needle of needles) required(text, needle)
}

describe('student dashboard visual organization', () => {
  test('keeps DashboardView TSX parseable through the supported TypeScript API', () => {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('keeps every original dashboard tab content mounted', () => {
    for (const tab of ['programs', 'supervision', 'lectures', 'payments', 'deliverables', 'notifications', 'thesis', 'transcript', 'certs']) {
      required(source, `<TabsContent value="${tab}"`)
    }
    required(source, "const allowedTabs = ['programs', 'supervision', 'lectures', 'payments', 'deliverables', 'notifications', 'thesis', 'transcript', 'certs']")
  })

  test('adds a polished student command center without removing the existing tabs', () => {
    required(source, 'بوصلتك الدراسية')
    required(source, 'قائمة خدمات بوابة الطالب')
    required(source, 'مرحبًا مجددًا')
    required(source, 'المهام العاجلة')
    required(source, 'الوحدات الأقرب لك')
    required(source, 'نصيحة اليوم')
    required(source, 'إشعارات مهمة')
    required(source, 'aria-label="القائمة الكاملة لتبويبات بوابة الطالب"')
    required(source, 'dashboardTabOptions.map')
    required(source, '<TabsList className="hidden">')
    required(source, 'const dashboardContentRef = useRef<HTMLDivElement | null>(null)')
    required(source, 'id="student-dashboard-content"')
    required(source, 'onValueChange={selectDashboardTab}')
  })

  test('keeps the polished layout responsive for mobile and desktop', () => {
    required(source, 'max-w-[1600px] px-3 py-5 sm:px-4 sm:py-8')
    required(source, 'xl:grid-cols-[210px_minmax(0,1fr)_340px]')
    required(source, 'lg:grid-cols-[minmax(0,1.35fr)_320px]')
    required(source, 'md:grid-cols-[1fr_250px]')
    required(source, 'sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6')
    required(source, 'xl:hidden')
    required(source, 'hidden rounded-[2rem]')
    required(source, 'from-[#0f2b46] via-[#2856d6] to-[#6d5dfc]')
  })

  test('keeps all important student areas reachable from the dropdown', () => {
    for (const label of [
      'الرئيسية والمقرر والكتاب',
      'المشرف الذكي وحواراته ونقاط القوة',
      'المحاضرات واللقاءات',
      'المدفوعات والرسوم',
      'المخرجات والخدمات',
      'الإشعارات والتنبيهات',
      'بحث التخرج والمناقشة',
      'السجل الأكاديمي',
      'الشهادات',
    ]) required(source, label)
  })

  test('keeps essential study work visible as primary cards', () => {
    for (const title of ['المقرر والكتاب', 'الوحدات والواجبات', 'المحاضرات واللقاءات', 'الامتحانات', 'الجدول الدراسي', 'المدفوعات والرسوم']) {
      required(source, `title: '${title}'`)
    }
    required(source, "action: () => openProgramWorkspace('schedule')")
    required(source, "action: () => openProgramWorkspace('content')")
    required(source, "action: () => openProgramWorkspace('progress')")
    required(source, "action: () => selectDashboardTab('lectures')")
    required(source, "action: () => selectDashboardTab('payments')")
  })

  test('keeps student navigation visual only without adding network calls', () => {
    requireAll(functionBody('selectDashboardTab'), [
      'setDashboardTab(tab)',
      'scrollToDashboardContent()',
    ])
    requireAll(functionBody('openProgramWorkspace'), [
      "setDashboardTab('programs')",
      'setProgramSection(section)',
      'scrollToDashboardContent()',
    ])
    const navModel = source.slice(source.indexOf('const dashboardTabOptions'), source.indexOf('return ('))
    expect(navModel.includes('api<')).toBe(false)
    expect(navModel.includes('fetch(')).toBe(false)
    expect(navModel.includes('localStorage')).toBe(false)
  })

  test('keeps supervisor access behavior protected', () => {
    requireAll(functionBody('openAiSupervisor'), [
      'if (!aiSupervisorAllowed)',
      "toast({ title: 'المشرف الذكي غير مفعل بعد'",
      "navigate('chat')",
    ])
    required(source, '<Button type="button" variant="outline" onClick={openAiSupervisor}')
  })

  test('adds a pulse notice and sound only behind explicit user action', () => {
    required(source, 'const pulseNotice = currentStudentAction')
    required(source, 'animate-ping')
    required(source, 'onClick={playStudentPulseTone}')
    required(source, 'function playStudentPulseTone()')
    expect(source.includes('useEffect(() => {\n    playStudentPulseTone')).toBe(false)
  })

  test('keeps existing student data and learning API contracts', () => {
    for (const apiCall of [
      "api<{ programs: any[] }>('/api/programs?summary=1')",
      "api<{ enrollments: MyEnrollment[] }>('/api/my/enrollments')",
      "api<ProgressData>(`/api/progress?programId=${programId}`)",
      "api<{ assignments: StudentAssignment[] }>(`/api/assignments?programId=${programId}`)",
      "api<{ guides: StudentStudyGuide[] }>(`/api/study-guides?programId=${programId}`)",
      "api<{ items: StudentStudyScheduleItem[] }>(`/api/study-schedule?programId=${programId}`)",
      "api<{ messages: ChatMsg[] }>('/api/chat')",
      "api<{ memory: AcademicMemorySnapshot | null }>('/api/my/academic-memory')",
      "api<StudentDashboardSummary>('/api/my/dashboard-summary')",
      "api<{ deliverables: ServiceDeliverableRow[] }>('/api/service-deliverables')",
      "fetch('/api/my/lectures', { cache: 'no-store' })",
    ]) required(source, apiCall)
  })
})
