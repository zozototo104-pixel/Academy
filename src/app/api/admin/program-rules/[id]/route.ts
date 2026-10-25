import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRules } from '@/lib/admission-ai'
import { buildOfficialStudyAdmissionDefaults, buildServiceAdmissionDefaults, getServiceFlow } from '@/lib/service-flows'

function parseProgramFeatures(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 12)
  const text = String(raw || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 12)
  } catch {
    // fall through to delimited text parsing
  }
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
    maxStudyDays: program.maxStudyDays ?? null,
    credentialType: program.credentialType || null,
    trademarkNotice: program.trademarkNotice || null,
    disclosureConsentText: program.disclosureConsentText || null,
    admissionRules: program.admissionRules || null,
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const program = await db.program.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        titleAr: true,
        titleEn: true,
        description: true,
        category: true,
        hours: true,
        maxStudyDays: true,
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
    const rules = program.admissionRules
      ? resolveRules(program.category, program.admissionRules, isStudyProgram)
      : (buildServiceAdmissionDefaults(flow) || (isStudyProgram ? buildOfficialStudyAdmissionDefaults(program) : resolveRules(program.category, program.admissionRules, isStudyProgram)))

    return NextResponse.json({
      item: {
        ...program,
        features: parseProgramFeatures(program.features),
        sortOrder: program.order,
        program: programSnapshot(program),
        rules,
        custom: !!program.admissionRules,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-rules detail GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل تفاصيل البرنامج' }, { status: 500 })
  }
}
