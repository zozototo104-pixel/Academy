import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { cleanAcademicOutput, looksLikeBrokenGeneratedArabic, sanitizeAcademicList } from '@/lib/academic-output-quality'

function jsonArray(value: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function cleanText(value: unknown, fallback: string, max = 3000) {
  const cleaned = cleanAcademicOutput(value, max)
  return cleaned && !looksLikeBrokenGeneratedArabic(cleaned) ? cleaned : fallback
}

function mapGuide(g: any) {
  const sections = jsonArray(g.sections)
    .map((s: any, i: number) => {
      const title = cleanText(s?.title, `محور دراسي ${i + 1}`, 180)
      const summary = cleanText(s?.summary, 'محور منظم من الكتب المقررة.', 1600)
      return {
        title,
        summary,
        outcomes: sanitizeAcademicList(s?.outcomes, ['شرح المحور وربطه بالتطبيق المهني'], 5, 180),
        sourceTitles: sanitizeAcademicList(s?.sourceTitles, ['بنك المعرفة'], 5, 160),
      }
    })
    .filter((s: any) => s.title && s.summary && !looksLikeBrokenGeneratedArabic(`${s.title}. ${s.summary}`))
    .slice(0, 8)

  const title = cleanText(g.title, 'دليل الدراسة', 220)
  const overview = cleanText(g.overview, 'دليل دراسة منظم يربط الكتب المقررة بالتطبيق المهني والاختبارات.', 7000)
  if (looksLikeBrokenGeneratedArabic(`${title}. ${overview}`)) return null

  return {
    id: g.id,
    programId: g.programId,
    semester: g.semester,
    title,
    overview,
    objectives: sanitizeAcademicList(jsonArray(g.objectives), ['فهم محاور البرنامج وربطها بالتطبيق المهني'], 10, 220),
    keyTerms: sanitizeAcademicList(jsonArray(g.keyTerms), [], 18, 90),
    sections,
    activities: sanitizeAcademicList(jsonArray(g.activities), ['قراءة المحاور وكتابة ملخص تطبيقي قصير.'], 8, 300),
    discussionQuestions: sanitizeAcademicList(jsonArray(g.discussionQuestions), ['كيف يمكن توظيف هذا المحور في حالة مهنية؟'], 10, 320),
    status: g.status,
    updatedAt: g.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const programId = req.nextUrl.searchParams.get('programId') || undefined
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id, status: { in: ['ACTIVE', 'COMPLETED'] }, ...(programId ? { programId } : {}) },
      select: { programId: true },
    })
    const programIds = enrollments.map((e) => e.programId)
    if (!programIds.length) return NextResponse.json({ guides: [] })

    const guides = await db.programStudyGuide.findMany({
      where: { programId: { in: programIds }, status: 'PUBLISHED' },
      orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
    })

    return NextResponse.json({ guides: guides.map(mapGuide).filter(Boolean) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('student study guides GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
}
