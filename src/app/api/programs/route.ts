import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { academicProfileFromRules, isGenericAllSpecializationsProgram, PROGRAM_CATEGORY_ORDER, PROGRAM_CATEGORY_AR, programSpecialtyLabel } from '@/lib/program-tracks'
import { resolveRules } from '@/lib/admission-ai'
import { buildServiceAdmissionDefaults, getServiceFlow } from '@/lib/service-flows'
import { getPublicProgramsCountCache, getPublicProgramsSummaryCache, setPublicProgramsCountCache, setPublicProgramsSummaryCache } from '@/lib/programs-public-cache'

function publicCacheHeaders() {
  return { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=1800' }
}

function isInternalQaProgram(p: { slug?: string | null; titleAr?: string | null; titleEn?: string | null }) {
  const slug = String(p.slug || '')
  const titleAr = String(p.titleAr || '')
  const titleEn = String(p.titleEn || '')
  return slug.startsWith('qa-full-journey-')
    || slug === 'launch-quality-diagnostic-program'
    || titleAr.startsWith('برنامج جودة رحلة كاملة QA')
    || titleEn.startsWith('QA Full Journey Program')
}

export async function GET(req: NextRequest) {
  try {
    const summaryOnly = req.nextUrl.searchParams.get('summary') === '1'
    const publicOnly = req.nextUrl.searchParams.get('public') === '1'
    const countOnly = req.nextUrl.searchParams.get('count') === '1'
    const detailId = req.nextUrl.searchParams.get('detail') || req.nextUrl.searchParams.get('id') || req.nextUrl.searchParams.get('slug')
    const liteOnly = !detailId && (summaryOnly || publicOnly || countOnly)
    if (!liteOnly && !detailId) await ensureCoreSeed()

    if (publicOnly && countOnly) {
      const now = Date.now()
      const countCache = getPublicProgramsCountCache()
      if (countCache && countCache.expiresAt > now) {
        return NextResponse.json({ count: countCache.count, catalogVersion: countCache.catalogVersion || null }, { headers: publicCacheHeaders() })
      }
      const summaryCache = getPublicProgramsSummaryCache()
      if (summaryCache && summaryCache.expiresAt > now) {
        const count = summaryCache.payload.programs.length
        setPublicProgramsCountCache(count, summaryCache.payload.catalogVersion || null)
        return NextResponse.json({ count, catalogVersion: summaryCache.payload.catalogVersion || null }, { headers: publicCacheHeaders() })
      }
      const countRows = await db.program.findMany({ where: { active: true }, select: { slug: true, titleAr: true, titleEn: true, updatedAt: true } })
      const visibleCountRows = countRows.filter((p) => !isGenericAllSpecializationsProgram(p) && !isInternalQaProgram(p))
      const count = visibleCountRows.length
      const catalogVersion = visibleCountRows.reduce<string | null>((latest, p) => {
        const value = p.updatedAt?.toISOString?.() || null
        return value && (!latest || value > latest) ? value : latest
      }, null)
      setPublicProgramsCountCache(count, catalogVersion)
      return NextResponse.json({ count, catalogVersion }, { headers: publicCacheHeaders() })
    }

    const summaryCache = getPublicProgramsSummaryCache()
    if (publicOnly && summaryOnly && summaryCache && summaryCache.expiresAt > Date.now()) {
      return NextResponse.json(summaryCache.payload, { headers: publicCacheHeaders() })
    }

    const programWhere = detailId
      ? { active: true, OR: [{ id: detailId }, { slug: detailId }] }
      : { active: true }

    const rows: any[] = liteOnly
      ? await db.program.findMany({
          where: programWhere,
          orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
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
            order: true,
            active: true,
            admissionRules: true,
            _count: { select: { units: true } },
          },
        })
      : await db.program.findMany({
          where: programWhere,
          orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
          include: {
            units: { orderBy: { order: 'asc' }, select: { id: true, order: true, title: true } },
            books: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, titleEn: true, semester: true, source: true } },
            assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, points: true, status: true } },
            studyGuides: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], select: { id: true, title: true, semester: true, overview: true } },
            programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { id: true, title: true, semester: true, status: true, _count: { select: { questions: true } } } },
          },
        })

    const programs = rows
      .filter((p) => !isGenericAllSpecializationsProgram(p) && !isInternalQaProgram(p))
      .sort((a, b) => {
        const ca = PROGRAM_CATEGORY_ORDER.indexOf(a.category)
        const cb = PROGRAM_CATEGORY_ORDER.indexOf(b.category)
        const oa = ca === -1 ? 999 : ca
        const ob = cb === -1 ? 999 : cb
        return oa - ob || a.order - b.order || a.titleAr.localeCompare(b.titleAr, 'ar')
      })

    const user = publicOnly ? null : await getCurrentUser()
    let enrolledProgramIds: string[] = []
    if (user) {
      const enrolls = await db.enrollment.findMany({
        where: { userId: user.id },
        select: { programId: true },
      })
      enrolledProgramIds = enrolls.map((e) => e.programId)
    }

    const payload = {
      programs: programs.map((p) => {
        const row = p as any
        const units = Array.isArray(row.units) ? row.units : []
        const books = Array.isArray(row.books) ? row.books : []
        const assignments = Array.isArray(row.assignments) ? row.assignments : []
        const studyGuides = Array.isArray(row.studyGuides) ? row.studyGuides : []
        const programExams = Array.isArray(row.programExams) ? row.programExams : []
        const flow = getServiceFlow(row.slug)
        const isStudyProgram = flow ? flow.isStudyProgram : row.category !== 'SERVICE'
        const admissionRules = row.admissionRules
          ? resolveRules(row.category, row.admissionRules, isStudyProgram)
          : (buildServiceAdmissionDefaults(flow) || resolveRules(row.category, row.admissionRules, isStudyProgram))
        return {
          id: row.id,
          slug: row.slug,
          titleAr: row.titleAr,
          titleEn: row.titleEn,
          description: row.description,
          category: row.category,
          categoryLabel: PROGRAM_CATEGORY_AR[row.category] || row.category,
          specialty: programSpecialtyLabel(row),
          hours: row.hours,
          price: row.price,
          icon: row.icon,
          features: JSON.parse(row.features || '[]'),
          unitsCount: liteOnly ? Number(row._count?.units || 0) : units.length,
          units,
          books,
          assignments,
          studyGuides,
          exams: programExams.map((e: any) => ({ id: e.id, title: e.title, semester: e.semester, status: e.status, questionCount: e._count?.questions || 0 })),
          enrolled: enrolledProgramIds.includes(row.id),
          // قواعد قبول/متطلبات خدمة يعرضها نموذج التقديم للمتقدم.
          admissionRules,
          // الملف الرسمي المخصص الذي تضبطه الإدارة لكل برنامج أو خدمة، إن وجد.
          academicProfile: academicProfileFromRules(admissionRules),
        }
      }),
    }

    if (publicOnly && summaryOnly) {
      const now = Date.now()
      publicProgramsSummaryCache = { payload, expiresAt: now + PUBLIC_PROGRAMS_CACHE_TTL_MS }
      publicProgramsCountCache = { count: payload.programs.length, expiresAt: now + PUBLIC_PROGRAMS_CACHE_TTL_MS }
    }

    const responsePayload = detailId
      ? { ...payload, program: payload.programs[0] || null }
      : payload

    return NextResponse.json(responsePayload, {
      headers: detailId
        ? { 'Cache-Control': 'private, no-store' }
        : publicOnly
          ? publicCacheHeaders()
          : { 'Cache-Control': 'private, no-store' },
    })
  } catch (e) {
    console.error('Programs error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل البرامج' }, { status: 500 })
  }
}
