import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const apiRoute = readFileSync('src/app/api/admin/ai-stage-profiles/route.ts', 'utf8')
const advisorRoute = readFileSync('src/app/api/admin/ai-advisor/route.ts', 'utf8')
const adminView = readFileSync('src/components/aact/AdminView.tsx', 'utf8')
const adminComponent = readFileSync('src/components/aact/AdminAiStageProfiles.tsx', 'utf8')

describe('D4 admin AI stage profiles surface', () => {
  test('the admin API is admin-only and saves through append-only stage profile storage', () => {
    expect(apiRoute).toContain('await requireAdmin()')
    expect(apiRoute).toContain('saveStageProfile(')
    expect(apiRoute).toContain('getCurrentStageProfile(')
    expect(apiRoute).toContain('listStageProfileVersions(')
    expect(apiRoute).toContain('getAiAdvisorReadiness()')
    expect(apiRoute).toContain("return NextResponse.json({ error: 'لا يوجد تغيير للحفظ' }, { status: 409 })")
    expect(apiRoute).not.toContain('questionRecheckTask.create')
    expect(apiRoute).not.toContain('advisorAdvice.create')
    expect(apiRoute).not.toContain('QuestionRecheck')
  })

  test('the UI is wired as a D4 profile/log tab with E0 readiness only', () => {
    expect(adminView).toContain('AdminAiStageProfiles')
    expect(adminView).toContain('value="ai-stage-profiles"')
    expect(adminComponent).toContain('بروفايلات مراحل الذكاء')
    expect(adminComponent).toContain('E0 — تقرير جاهزية المستشار')
    expect(adminComponent).toContain('قراءة جاهزية فقط')
    expect(adminComponent).toContain('advisorReadiness')
    expect(adminComponent).toContain('آخر تشغيلات هذه المرحلة')
    expect(adminComponent).not.toContain('advisorAdvice')
    expect(adminComponent).not.toContain('applyAdvice')
    expect(adminComponent).not.toContain('generateAdvice')
    expect(adminComponent).not.toContain('/api/admin/ai-advisor')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })

  test('saving a stage profile posts only the stage snapshot and is not blind', () => {
    expect(adminComponent).toContain("api<{ stage: StageData }>('/api/admin/ai-stage-profiles'")
    expect(adminComponent).toContain('JSON.stringify({ stage, snapshot })')
    expect(adminComponent).toContain('snapshotKey(snapshot) === snapshotKey(currentSnapshot)')
    expect(adminComponent).toContain('معاينة التغييرات قبل إنشاء نسخة جديدة')
    expect(adminComponent).toContain('استرجاع الحالي')
    expect(adminComponent).not.toContain('allowGlobalFallback: false, //')
  })
})
