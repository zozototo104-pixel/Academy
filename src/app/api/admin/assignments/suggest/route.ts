import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { geminiCompleteJson } from '@/lib/gemini'
import { ensureProgramKnowledge, getProgramKnowledgeItems, cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput } from '@/lib/knowledge-bank'

export const runtime = 'nodejs'
export const maxDuration = 180

interface AssignmentSuggestion {
  title: string
  description: string
  type: string
  semester: number
  points: number
  weight: number
  dueDays: number
  rubric: string
  sourceKnowledgeTitles: string[]
}

const TYPE_SET = new Set(['REPORT', 'CASE_STUDY', 'SUMMARY', 'PROJECT', 'REFLECTION'])

function clean(value: unknown, max = 2000) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanAssignmentText(value: unknown, fallback = '', max = 2000, allowShort = false) {
  const cleaned = cleanAcademicGeneratedText(value, max).replace(/\s+/g, ' ').trim()
  return cleaned && !looksLikeBrokenAcademicOutput(cleaned, { allowShort }) ? cleaned : fallback
}

function cleanAssignmentList(values: unknown, fallback: string[] = [], maxItems = 6) {
  const seen = new Set<string>()
  const out: string[] = []
  const raw = Array.isArray(values) ? values : []
  for (const item of [...raw, ...fallback]) {
    const cleaned = cleanAssignmentText(item, '', 140, true)
    const key = cleaned.toLowerCase().replace(/\s+/g, ' ')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function asInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function arrayFromJson(value: any): any[] {
  if (Array.isArray(value)) return value
  for (const key of ['suggestions', 'items', 'data', 'assignments', 'results']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function parseJsonArray(raw: string): any[] {
  const body = clean(raw, 20000)
  try { return arrayFromJson(JSON.parse(body)) } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try { return arrayFromJson(JSON.parse(fenced)) } catch {}
  }
  const arr = body.match(/\[[\s\S]*\]/)?.[0]
  if (arr) {
    try { return arrayFromJson(JSON.parse(arr)) } catch {}
  }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) {
    try { return arrayFromJson(JSON.parse(obj)) } catch {}
  }
  return []
}

function normalizeSuggestions(raw: any[], semester: number, knowledgeTitles: string[]): AssignmentSuggestion[] {
  const seen = new Set<string>()
  const out: AssignmentSuggestion[] = []
  for (const item of raw) {
    const title = cleanAssignmentText(item?.title, '', 180, true)
    const description = cleanAssignmentText(item?.description, '', 5000)
    if (!title || !description) continue
    if (looksLikeBrokenAcademicOutput(`${title}. ${description}`)) continue
    const key = title.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    const type = TYPE_SET.has(String(item?.type || '').toUpperCase()) ? String(item.type).toUpperCase() : 'CASE_STUDY'
    const src = cleanAssignmentList(item?.sourceKnowledgeTitles, knowledgeTitles.slice(0, 4), 6)
    out.push({
      title,
      description,
      type,
      semester: asInt(item?.semester, semester, 1, 3),
      points: asInt(item?.points, 15, 5, 100),
      weight: asInt(item?.weight, 0, 0, 100),
      dueDays: asInt(item?.dueDays, 14, 1, 365),
      rubric: cleanAssignmentText(item?.rubric, 'وضوح الفكرة 20%، عمق التحليل 35%، الارتباط بالكتاب 25%، جودة العرض والاستنتاجات 20%', 1600),
      sourceKnowledgeTitles: src,
    })
    if (out.length >= 6) break
  }
  return out
}

function fallbackSuggestions(programTitle: string, semester: number, knowledge: Awaited<ReturnType<typeof getProgramKnowledgeItems>>): AssignmentSuggestion[] {
  const top = knowledge.slice(0, 12)
  const titles = top.map((k) => k.title).filter(Boolean)
  const first = top[0]
  const second = top.find((k) => k.category === 'CASE') || top[1]
  const third = top.find((k) => k.category === 'METHOD' || k.category === 'THEORY') || top[2]
  const pick = (i: number) => top[i]?.title || `محور معرفي من ${programTitle}`
  return [
    {
      title: `تحليل تطبيقي لأهم مفاهيم ${programTitle}`,
      description: `اكتب تقريراً تحليلياً يربط بين محاور الكتاب/الكتب المقررة وبين واقع ${programTitle}. ابدأ بعرض مختصر للمفاهيم الأساسية مثل: ${titles.slice(0, 4).join('، ')}، ثم طبّقها على حالة مهنية واقعية، مع توضيح الفائدة العملية والقيود المحتملة.`,
      type: 'REPORT', semester, points: 15, weight: 0, dueDays: 14,
      rubric: 'دقة فهم المفاهيم 25%، الربط بالتخصص 30%، التطبيق العملي 25%، جودة اللغة والتنظيم 20%',
      sourceKnowledgeTitles: titles.slice(0, 5),
    },
    {
      title: `دراسة حالة مبنية على ${second?.title || pick(1)}`,
      description: `حوّل الفكرة أو الحالة الواردة في بنك المعرفة إلى سيناريو مهني قابل للنقاش. عرّف المشكلة، أصحاب المصلحة، القرارات المتاحة، المخاطر، ثم قدّم توصية مبررة مستندة إلى محتوى الكتاب وليس إلى رأي عام.`,
      type: 'CASE_STUDY', semester, points: 20, weight: 0, dueDays: 10,
      rubric: 'بناء الحالة 20%، تحليل أصحاب المصلحة والمخاطر 30%، الاستناد للمصدر 25%، جودة التوصية 25%',
      sourceKnowledgeTitles: [second?.title || pick(1), first?.title || pick(0)].filter(Boolean),
    },
    {
      title: `خريطة مفاهيم ومنهجيات من الكتاب المقرر`,
      description: `صمّم خريطة موجزة توضّح العلاقة بين المفاهيم والمنهجيات والنظريات المهمة مثل: ${[third?.title, pick(3), pick(4)].filter(Boolean).join('، ')}. أرفق شرحاً قصيراً يوضح كيف تساعد هذه الخريطة في فهم التخصص وتطبيقه.`,
      type: 'SUMMARY', semester, points: 10, weight: 0, dueDays: 7,
      rubric: 'شمولية الخريطة 30%، صحة العلاقات 30%، الارتباط بالكتاب 25%، وضوح العرض 15%',
      sourceKnowledgeTitles: [third?.title || pick(2), pick(3), pick(4)].filter(Boolean),
    },
  ]
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = asInt(body.semester, 1, 1, 3)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, titleEn: true, category: true, description: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const knowledgeSemester = semester === 3 ? null : semester
    await ensureProgramKnowledge(programId, knowledgeSemester, 8).catch(() => null)
    const knowledge = await getProgramKnowledgeItems(programId, knowledgeSemester, 36)
    if (!knowledge.length) {
      return NextResponse.json({ error: 'لا يوجد بنك معرفة كافٍ. أضف كتاباً أو اضغط بناء/تحديث بنك المعرفة أولاً.' }, { status: 400 })
    }

    const existing = await db.programAssignment.findMany({ where: { programId }, select: { title: true } })
    const existingTitles = existing.map((a) => a.title).join('، ')
    const knowledgeTitles = knowledge.map((k) => k.title).slice(0, 10)
    const knowledgeContext = knowledge.slice(0, 22).map((k, i) => {
      const source = k.bookTitle ? ` — من كتاب ${k.bookTitle}` : ''
      return `${i + 1}. ${k.title}: ${k.summary.slice(0, 320)}${source}`
    }).join('\n')

    const assignmentPrompt = `صمم 4 إلى 6 واجبات أكاديمية مهنية من بنك المعرفة التالي.

البرنامج: ${program.titleAr}
التصنيف: ${program.category}
الفصل: ${semester === 2 ? 'الثاني' : semester === 3 ? 'بحث/مشروع' : 'الأول'}
وصف البرنامج: ${program.description || '-'}
الواجبات الموجودة مسبقاً لتجنب التكرار: ${existingTitles || 'لا يوجد'}

محتوى منظم من الكتب المقررة:
${knowledgeContext}

الشروط:
- كل واجب يجب أن يكون مرتبطاً صراحة بالكتاب/المعرفة، لا عاماً.
- نوّع بين: REPORT, CASE_STUDY, SUMMARY, PROJECT, REFLECTION.
- اكتب وصفاً واضحاً يصلح للطالب مباشرة.
- اكتب Rubric قابل للتصحيح بالنسب.
- لا تستخدم كلمات تقنية إنجليزية داخل العنوان والوصف إلا أسماء المصطلحات الضرورية.
- لا تنشئ واجباً من عنوان البرنامج فقط؛ اربطه بعنصر معرفة محدد.

أجب JSON فقط كمصفوفة، وكل عنصر بهذه الحقول:
title, description, type, semester, points, weight, dueDays, rubric, sourceKnowledgeTitles`

    let suggestions: AssignmentSuggestion[] = []
    try {
      const raw = await Promise.race([
        geminiCompleteJson({
          system: 'أنت مصمم تكليفات جامعية مهنية. أعد JSON array صالحاً فقط دون Markdown.',
          history: [{ role: 'user', text: assignmentPrompt }],
          temperature: 0.12,
          maxOutputTokens: 6144,
        }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('ASSIGNMENT_GEMINI_TIMEOUT')), 32000)),
      ])
      suggestions = normalizeSuggestions(parseJsonArray(raw), semester, knowledgeTitles)
    } catch (e: any) {
      console.error('assignment suggestions Gemini fallback:', String(e?.message || e).slice(0, 300))
    }

    if (suggestions.length < 3) {
      try {
        const zai = await getZAI()
        const raw = await Promise.race([
          chatWithRetry(zai, [
            { role: 'assistant', content: 'أنت مصمم تكليفات جامعية مهنية. أعد JSON صالحاً فقط.' },
            { role: 'user', content: assignmentPrompt },
          ], 2),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('ASSIGNMENT_ZAI_TIMEOUT')), 28000)),
        ])
        suggestions = normalizeSuggestions([...suggestions, ...parseJsonArray(raw)], semester, knowledgeTitles)
      } catch (e: any) {
        console.error('assignment suggestions AI fallback:', String(e?.message || e).slice(0, 300))
      }
    }

    if (suggestions.length < 3) {
      suggestions = normalizeSuggestions([...suggestions, ...fallbackSuggestions(program.titleAr, semester, knowledge)], semester, knowledgeTitles)
    }

    return NextResponse.json({ suggestions })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('assignment suggestions error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر اقتراح الواجبات' }, { status: 500 })
  }
}
