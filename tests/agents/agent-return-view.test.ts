// حارس العودة إلى النموذج بعد الدخول + رحلة المسجّل الجديد (مرحلة 2 — 2026-11-18):
// ضيف يملأ النموذج، يذهب للدخول، يعود إلى نموذجه نفسه بمسودته وملفاته
// المرحّلة — لا إلى لوحته. الدخول العادي بلا مؤشر يبقى إلى اللوحة.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

process.env.AACT_UPLOAD_TOKEN_SECRET = 'agent-return-test-secret'

// Bun بلا localStorage افتراضياً — محاكاة ذاكرة للاختبار فقط.
const lsStore = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
}

const { setPendingReturnView, peekPendingReturnView, clearPendingReturnView } = await import('@/lib/pending-return-view')
const { readAgentDraft, saveAgentDraft, clearAgentDraft, readAgentStagedDocs, saveAgentStagedDocs, clearAgentStagedDocs } = await import('@/lib/agent-draft')
const { getPendingAgentFiles, setPendingAgentFile, clearPendingAgentFiles } = await import('@/lib/agent-pending-files')

describe('مؤشر العودة إلى النموذج', () => {
  test('يُضبط ويُقرأ ثم يُمسح عند الاستعمال', () => {
    clearPendingReturnView()
    expect(peekPendingReturnView()).toBeNull()
    setPendingReturnView('agent')
    expect(peekPendingReturnView()).toBe('agent')
    clearPendingReturnView()
    expect(peekPendingReturnView()).toBeNull()
  })

  test('قيمة غير صالحة تُرفض', () => {
    lsStore.set('aact_pending_return_view', JSON.stringify({ view: 'dashboard', at: Date.now() }))
    expect(peekPendingReturnView()).toBeNull()
  })

  test('مؤشر منتهي (أقدم من 24 ساعة) يُرفض ويُمسح', () => {
    lsStore.set('aact_pending_return_view', JSON.stringify({ view: 'agent', at: Date.now() - 25 * 60 * 60 * 1000 }))
    expect(peekPendingReturnView()).toBeNull()
    expect(lsStore.has('aact_pending_return_view')).toBe(false)
  })
})

describe('مسودة الوكالة والملفات المرحّلة', () => {
  test('مسودة النصوص تُحفظ وتُقرأ وتُمسح', () => {
    clearAgentDraft()
    expect(readAgentDraft()).toBeNull()
    saveAgentDraft({ form: { orgName: 'مؤسسة يد بيد', repName: 'اختبار' }, kind: 'AGENCY', accreditationType: 'CONSULTANT' })
    expect(readAgentDraft()).toEqual({ form: { orgName: 'مؤسسة يد بيد', repName: 'اختبار' }, kind: 'AGENCY', accreditationType: 'CONSULTANT' })
    clearAgentDraft()
    expect(readAgentDraft()).toBeNull()
  })

  test('مفاتيح المرحّلة تُحفظ وتُقرأ وتُمسح بمعزل عن مسودة النصوص', () => {
    clearAgentStagedDocs()
    clearAgentDraft()
    expect(readAgentStagedDocs()).toEqual([])
    saveAgentDraft({ form: { orgName: 'مؤسسة يد بيد' }, kind: 'AGENCY' })
    saveAgentStagedDocs([{ docType: 'LICENSE', storageKey: 'agent-documents/license/2026-11-18/k1', uploadToken: 't1', fileUrl: '/f1', fileName: 'license.png', mimeType: 'image/png', size: 100 }])
    expect(readAgentStagedDocs().map((d) => d.storageKey)).toEqual(['agent-documents/license/2026-11-18/k1'])
    expect(readAgentDraft()?.form?.orgName).toBe('مؤسسة يد بيد')
    clearAgentStagedDocs()
    expect(readAgentStagedDocs()).toEqual([])
    expect(readAgentDraft()?.form?.orgName).toBe('مؤسسة يد بيد')
    clearAgentDraft()
  })

  test('ملفات الحافظة (قبل الدخول) تنجو وتُمسح عند النجاح', () => {
    clearPendingAgentFiles()
    expect(getPendingAgentFiles()).toEqual({})
    const f = new File(['x'], 'id.png', { type: 'image/png' })
    setPendingAgentFile('ID', f)
    expect(getPendingAgentFiles().ID).toBe(f)
    setPendingAgentFile('ID', null)
    expect(getPendingAgentFiles()).toEqual({})
    setPendingAgentFile('ID', f)
    clearPendingAgentFiles()
    expect(getPendingAgentFiles()).toEqual({})
  })
})

describe('رحلة المسجّل الجديد: عودة + مسودة + ملفات مرحّلة', () => {
  test('مؤشر العودة ومسودة النصوص والمفاتيح المرحّلة تكمل معاً بعد التسجيل', () => {
    // ضيف ملأ النموذج ورحّل ملفاً ثم ذهب للتسجيل (حساب جديد لأول مرة).
    clearPendingReturnView()
    clearAgentDraft()
    clearAgentStagedDocs()
    setPendingReturnView('agent')
    saveAgentDraft({ form: { orgName: 'مؤسسة يد بيد', repName: 'اختبار', email: 'new@test.com' }, kind: 'AGENCY' })
    saveAgentStagedDocs([{ docType: 'LICENSE', storageKey: 'agent-documents/license/2026-11-18/k1', uploadToken: 't1', fileUrl: '/f1', fileName: 'license.png', mimeType: 'image/png', size: 100 }])
    // بعد نجاح التسجيل/الدخول تقرأ شاشة الدخول المؤشر فتعيده إلى نموذجه:
    expect(peekPendingReturnView()).toBe('agent')
    clearPendingReturnView()
    expect(peekPendingReturnView()).toBeNull()
    // والنموذج يستعيد نصوصه ومفاتيحه المرحّلة:
    expect(readAgentDraft()?.form?.orgName).toBe('مؤسسة يد بيد')
    expect(readAgentStagedDocs().map((d) => d.docType)).toEqual(['LICENSE'])
    clearAgentDraft()
    clearAgentStagedDocs()
  })
})

describe('توصيلات واجهة المرحلة الثانية', () => {
  test('صفحة /agent تبدّل العروض وتظهر شاشة الدخول', () => {
    const client = readFileSync('src/app/agent/AgentStandaloneClient.tsx', 'utf8')
    expect(client).toContain("effectiveView === 'auth'")
    expect(client).toContain('<AuthView />')
    expect(client).toContain('<AgentView />')
    expect(client).toContain('window.location.assign(pathForView')
    const page = readFileSync('src/app/agent/page.tsx', 'utf8')
    expect(page).toContain('AgentStandaloneClient')
    expect(page).not.toContain('<AgentView />')
  })

  test('النموذج يضبط مؤشر العودة ويرحّل الملفات ويحفظ المفاتيح', () => {
    const agentView = readFileSync('src/components/aact/AgentView.tsx', 'utf8')
    expect(agentView).toContain("setPendingReturnView('agent')")
    expect(agentView).toContain("navigate('auth')")
    expect(agentView).toContain("'/api/agent-apply/files'")
    expect(agentView).toContain('stagedDocs')
    expect(agentView).toContain('saveAgentStagedDocs')
    expect(agentView).toContain('getPendingAgentFiles')
    expect(agentView).toContain('clearAgentStagedDocs')
    expect(agentView).toContain('notStaged')
    expect(agentView).toContain('إعادة رفع الملف')
    expect(agentView).not.toContain('fd.append(`doc_')
    const applyView = readFileSync('src/components/aact/ApplyView.tsx', 'utf8')
    expect(applyView).toContain("setPendingReturnView('apply')")
  })

  test('شاشة الدخول تعيد إلى النموذج بعد الدخول والتسجيل', () => {
    const authView = readFileSync('src/components/aact/AuthView.tsx', 'utf8')
    expect(authView).toContain('peekPendingReturnView')
    expect(authView.split('navigate(pendingReturn)').length - 1).toBe(2)
    expect(authView).toContain('clearPendingReturnView')
  })

  test('مسار التقديم يقبل الوثائق المرحّلة ويثبت رمزها', () => {
    const route = readFileSync('src/app/api/agent-apply/route.ts', 'utf8')
    expect(route).toContain('stagedDocs')
    expect(route).toContain('readAgentUploadToken')
    expect(route).toContain('agent-documents/${docType.toLowerCase()}/')
    const filesRoute = readFileSync('src/app/api/agent-apply/files/route.ts', 'utf8')
    expect(filesRoute).toContain('createAgentUploadToken')
    expect(filesRoute).toContain('LOGIN_REQUIRED')
  })
})
