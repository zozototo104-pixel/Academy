import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { awardEligibleMicroCredentials } from '@/lib/micro-credentials'

export const dynamic = 'force-dynamic'

function microSkillLabel(value?: string | null): string {
  const raw = String(value || '').trim()
  const map: Record<string, string> = {
    PROFESSIONAL_FOUNDATIONS: 'أساسيات مهنية',
    FOUNDATIONS: 'أساسيات مهنية',
    APPLIED_ANALYSIS: 'التحليل والتطبيق المهني',
    CAPSTONE_PROJECT: 'المشروع أو البحث التطبيقي',
    CAPSTONE_READY: 'المشروع أو البحث التطبيقي',
  }
  return raw ? (map[raw] || raw.replace(/_/g, ' ')) : 'مهارة مهنية'
}

function toCard(award: any) {
  const credential = award.microCredential || award
  const program = credential.program || award.microCredential?.program
  let evidence: any = null
  try {
    evidence = award.evidence ? JSON.parse(award.evidence) : null
  } catch {
    evidence = null
  }
  return {
    id: award.id || credential.id,
    awardId: award.microCredential ? award.id : null,
    credentialId: credential.id,
    titleAr: credential.titleAr,
    titleEn: credential.titleEn,
    skillArea: credential.skillArea,
    description: credential.description,
    learningOutcome: credential.learningOutcome,
    badgeCode: credential.badgeCode,
    programTitle: program?.titleAr || '',
    issuedAt: award.issuedAt || null,
    valid: award.valid ?? true,
    evidence,
  }
}

export async function GET() {
  try {
    const user = await requireUser()
    const { earned, available, awardedNow } = await awardEligibleMicroCredentials(user.id)
    return NextResponse.json({
      earned: earned.map(toCard),
      available: available.map(toCard),
      awardedNow: awardedNow.map(toCard),
    })
  } catch (e: any) {
    const status = e?.message === 'UNAUTHORIZED' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'غير مصرح' : 'تعذر تحميل شهادات المهارات الصغيرة' }, { status })
  }
}
