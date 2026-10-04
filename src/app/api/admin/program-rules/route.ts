import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { clearAdmissionAiReviewCacheForProgram, resolveRules, type AdmissionRules } from '@/lib/admission-ai'
import { normalizeAcademicProfileOverride } from '@/lib/program-tracks'
import { clearPublicProgramsCache } from '@/lib/programs-public-cache'
import { compactChangeSummary, pickChangedFields } from '@/lib/program-rules-audit'
import { buildOfficialStudyAdmissionDefaults, buildServiceAdmissionDefaults, getServiceFlow } from '@/lib/service-flows'

function isInternalQaProgram(p: { slug?: string | null; titleAr?: string | null; titleEn?: string | null }) {
  const slug = String(p.slug || '')
  const titleAr = String(p.titleAr || '')
  const titleEn = String(p.titleEn || '')
  return slug.startsWith('qa-full-journey-')
    || slug === 'launch-quality-diagnostic-program'
    || titleAr.startsWith('برنامج جودة رحلة كاملة QA')
    || titleEn.startsWith('QA Full Journey Program')
}

const PROGRAM_CATEGORIES = ['DIPLOMA', 'DOCTORATE', 'MASTERS', 'ACCREDITATION', 'INTL_CERT', 'SERVICE'] as const
const CREDENTIAL_TYPES = ['PROFESSIONAL_MASTER', 'PROFESSIONAL_DOCTORATE', 'DIPLOMA', 'PROFESSIONAL_CERTIFICATE', 'SERVICE'] as const

const programPatchSchema = z.object({
  titleAr: z.string().trim().min(1, 'اسم البرنامج العربي مطلوب').max(220).optional(),
  titleEn: z.string().trim().max(220).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  category: z.enum(PROGRAM_CATEGORIES).optional(),
  icon: z.string().trim().max(80).optional(),
  features: z.array(z.string().trim().min(1).max(180)).max(12, 'الميزات بحد أقصى 12').optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  price: z.coerce.number().min(0, 'السعر يجب أن يكون صفراً أو أكثر').nullable().optional(),
  hours: z.coerce.number().int().min(1, 'الساعات يجب أن تكون أكبر من صفر').max(10000).optional(),
  credentialType: z.enum(CREDENTIAL_TYPES).nullable().optional(),
  trademarkNotice: z.string().trim().max(1200).nullable().optional(),
  disclosureConsentText: z.string().trim().max(2000).nullable().optional(),
})

type ProgramPatchInput = z.infer<typeof programPatchSchema>

const bulkApplyPriceHoursSchema = z.object({
  category: z.enum(PROGRAM_CATEGORIES),
  price: z.coerce.number().min(0, 'السعر يجب أن يكون صفراً أو أكثر'),
  hours: z.coerce.number().int().min(1, 'الساعات يجب أن تكون أكبر من صفر').max(10000),
})

function normalizeFeaturesForDb(features?: string[]) {
  if (!features) return undefined
  return JSON.stringify(features.map((item) => item.trim()).filter(Boolean).slice(0, 12))
}

function parseProgramFeatures(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 12)
  const text = String(raw || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 12)
  } catch {}
  return text.split(/\r?\n|،|,/).map((item) => item.trim()).filter(Boolean).slice(0, 12)
}

function programSnapshot(program: any) {
  return {
    titleAr: program.titleAr,
    titleEn: program.titleEn,
    description: program.description,
    category: program.category,
    icon: program.icon,
    features: parseProgramFeatures(program.features),
    active: program.active,
    sortOrder: program.order,
    price: program.price,
    hours: program.hours,
    credentialType: program.credentialType || null,
    trademarkNotice: program.trademarkNotice || null,
    disclosureConsentText: program.disclosureConsentText || null,
    admissionRules: program.admissionRules || null,
  }
}

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
    select: {
      id: true,
      slug: true,
      titleAr: true,
      titleEn: true,
      description: true,
      category: true,
      hours: true,
      price: true,
      icon: true,
      features: true,
      active: true,
      order: true,
      credentialType: true,
      trademarkNotice: true,
      disclosureConsentText: true,
      admissionRules: true,
      _count: { select: { units: true } },
    },
  })
  const visiblePrograms = programs.filter((p) => !isInternalQaProgram(p))
  return NextResponse.json({
    programs: visiblePrograms.map((p) => {
      const flow = getServiceFlow(p.slug)
      const isStudyProgram = flow ? flow.isStudyProgram : p.category !== 'SERVICE'
      return {
        ...p,
        features: parseProgramFeatures(p.features),
        sortOrder: p.order,
        program: programSnapshot(p),
        rules: p.admissionRules
          ? resolveRules(p.category, p.admissionRules, isStudyProgram)
          : (buildServiceAdmissionDefaults(flow) || (isStudyProgram ? buildOfficialStudyAdmissionDefaults(p) : resolveRules(p.category, p.admissionRules, isStudyProgram))),
        custom: !!p.admissionRules,
      }
    }),
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
    const programPatchRaw = body.programPatch || body.program || null
    const programPatch: ProgramPatchInput | null = programPatchRaw ? programPatchSchema.parse(programPatchRaw) : null
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({
      where: { id: programId },
      select: {
        id: true,
        slug: true,
        titleAr: true,
        titleEn: true,
        description: true,
        category: true,
        hours: true,
        price: true,
        icon: true,
        features: true,
        active: true,
        order: true,
        credentialType: true,
        trademarkNotice: true,
        disclosureConsentText: true,
        admissionRules: true,
        _count: { select: { units: true } },
      },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    const flow = getServiceFlow(program.slug)
    const isStudyProgram = flow ? flow.isStudyProgram : program.category !== 'SERVICE'

    // reset=true يعيد القواعد الافتراضية (يمسح التخصيص)
    if (rules?.reset) {
      await db.program.update({ where: { id: programId }, data: { admissionRules: Prisma.DbNull } })
      clearPublicProgramsCache()
      const invalidated = await clearAdmissionAiReviewCacheForProgram(programId)
      await audit(user, 'PROGRAM_RULES_RESET', 'Program', programId, `أعاد الإدارة قواعد قبول «${program.titleAr}» للافتراضية — أُبطلت مراجعات قبول ذكية: ${invalidated.count}`)
      return NextResponse.json({ ok: true, rules: buildServiceAdmissionDefaults(flow) || (isStudyProgram ? buildOfficialStudyAdmissionDefaults(program) : resolveRules(program.category, null, isStudyProgram)), custom: false, invalidatedAdmissionAiReviews: invalidated.count })
    }

    const before = programSnapshot(program)
    const data: Prisma.ProgramUpdateInput = {}
    let clean: AdmissionRules | null = null

    // تنقية القواعد الواردة، مع الحفاظ على القواعد القديمة إذا لم تُرسل rules في الطلب.
    if (rules) {
      const EDU = ['HIGH_SCHOOL', 'BACHELOR', 'MASTER', 'NONE']
      const r: AdmissionRules = rules || {}
      clean = {}
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
      data.admissionRules = JSON.parse(JSON.stringify(clean))
    }

    if (programPatch) {
      if (programPatch.titleAr !== undefined) data.titleAr = programPatch.titleAr
      if (programPatch.titleEn !== undefined) data.titleEn = programPatch.titleEn || null
      if (programPatch.description !== undefined) data.description = programPatch.description || ''
      if (programPatch.category !== undefined) data.category = programPatch.category as any
      if (programPatch.icon !== undefined) data.icon = programPatch.icon || 'graduation-cap'
      if (programPatch.features !== undefined) data.features = normalizeFeaturesForDb(programPatch.features)
      if (programPatch.active !== undefined) data.active = programPatch.active
      if (programPatch.sortOrder !== undefined) data.order = programPatch.sortOrder
      if (programPatch.price !== undefined) data.price = programPatch.price === null ? null : Number(programPatch.price)
      if (programPatch.hours !== undefined) data.hours = Number(programPatch.hours)
      if (programPatch.credentialType !== undefined) data.credentialType = programPatch.credentialType || null
      if (programPatch.trademarkNotice !== undefined) data.trademarkNotice = programPatch.trademarkNotice || null
      if (programPatch.disclosureConsentText !== undefined) data.disclosureConsentText = programPatch.disclosureConsentText || null
    }

    if (!Object.keys(data).length) {
      return NextResponse.json({ error: 'لا توجد بيانات للحفظ' }, { status: 400 })
    }

    const saved = await db.program.update({ where: { id: programId }, data })
    clearPublicProgramsCache()
    const invalidated = await clearAdmissionAiReviewCacheForProgram(programId)
    const after = programSnapshot(saved)
    const changes = pickChangedFields(before, after)
    await audit(user, 'PROGRAM_RULES_SAVED', 'Program', programId, `حفظ محرر البرنامج «${saved.titleAr}» — ${compactChangeSummary(changes)} — أُبطلت مراجعات قبول ذكية: ${invalidated.count}`)
    const savedFlow = getServiceFlow(saved.slug)
    const savedIsStudyProgram = savedFlow ? savedFlow.isStudyProgram : saved.category !== 'SERVICE'
    return NextResponse.json({
      ok: true,
      program: programSnapshot(saved),
      rules: resolveRules(saved.category, saved.admissionRules, savedIsStudyProgram),
      custom: !!saved.admissionRules,
      invalidatedAdmissionAiReviews: invalidated.count,
    })
  } catch (e: any) {
    console.error('program-rules error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر حفظ القواعد' }, { status: 500 })
  }
}
