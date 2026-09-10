import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { resolveRules, type AdmissionRules } from '@/lib/admission-ai'
import { normalizeAcademicProfileOverride } from '@/lib/program-tracks'

// GET  /api/admin/program-rules — قائمة البرامج بقواعد قبولها (المخصصة + المفعّلة فعلياً)
// PUT  /api/admin/program-rules — حفظ قواعد قبول مخصصة لبرنامج بعينه
// القواعد المخصصة يقرأها خبير القبول الذكي ويطبقها على كل طلب قبل زر الاعتماد
export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
  }
  const programs = await db.program.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { order: 'asc' }],
    select: { id: true, slug: true, titleAr: true, titleEn: true, description: true, category: true, hours: true, admissionRules: true, _count: { select: { units: true } } },
  })
  return NextResponse.json({
    programs: programs.map((p) => ({
      ...p,
      rules: resolveRules(p.category, p.admissionRules),
      custom: !!p.admissionRules,
    })),
  })
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const body = await req.json().catch(() => ({}))
    const { programId } = body as { programId?: string }
    const rules = (body.rules || {}) as (AdmissionRules & { reset?: boolean }) | undefined
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, category: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    // reset=true يعيد القواعد الافتراضية (يمسح التخصيص)
    if (rules?.reset) {
      await db.program.update({ where: { id: programId }, data: { admissionRules: Prisma.DbNull } })
      await audit(user, 'PROGRAM_RULES_RESET', 'Program', programId, `أعاد الإدارة قواعد قبول «${program.titleAr}» للافتراضية`)
      return NextResponse.json({ ok: true, rules: resolveRules(program.category, null), custom: false })
    }

    // تنقية القواعد الواردة
    const EDU = ['HIGH_SCHOOL', 'BACHELOR', 'MASTER', 'NONE']
    const r: AdmissionRules = rules || {}
    const clean: AdmissionRules = {}
    if (r.minEducation && EDU.includes(r.minEducation)) clean.minEducation = r.minEducation
    if (typeof r.requireMasterForDoctorate === 'boolean') clean.requireMasterForDoctorate = r.requireMasterForDoctorate
    if (typeof r.allowExperienceEquivalency === 'boolean') clean.allowExperienceEquivalency = r.allowExperienceEquivalency
    if (Number.isFinite(Number(r.minYearsExperience))) clean.minYearsExperience = Math.max(0, Math.min(40, Math.round(Number(r.minYearsExperience))))
    if (Array.isArray(r.requiredDocuments)) clean.requiredDocuments = r.requiredDocuments.filter((d) => typeof d === 'string' && d.length <= 40).slice(0, 10)
    if (Number.isFinite(Number(r.minAge))) clean.minAge = Math.max(12, Math.min(80, Math.round(Number(r.minAge))))
    if (typeof r.customRules === 'string') clean.customRules = r.customRules.slice(0, 3000)
    if (typeof r.displayNote === 'string') clean.displayNote = r.displayNote.slice(0, 600)
    const academicProfile = normalizeAcademicProfileOverride(r.academicProfile)
    if (academicProfile) clean.academicProfile = academicProfile

    const saved = await db.program.update({ where: { id: programId }, data: { admissionRules: JSON.parse(JSON.stringify(clean)) } })
    await audit(user, 'PROGRAM_RULES_SAVED', 'Program', programId, `حفظ قواعد قبول مخصصة لبرنامج «${program.titleAr}»`)
    return NextResponse.json({ ok: true, rules: resolveRules(program.category, saved.admissionRules), custom: true })
  } catch (e: any) {
    console.error('program-rules error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر حفظ القواعد' }, { status: 500 })
  }
}
