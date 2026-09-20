import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { geminiCompleteJson } from '@/lib/gemini'
import { audit } from '@/lib/notify'

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseJsonObject(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON')
}

function safeObjectives(value: unknown) {
  const arr = Array.isArray(value) ? value : []
  return arr.map((x) => cleanText(x, 220)).filter((x) => x.length > 6).slice(0, 6)
}

function safeContent(value: unknown, fallbackSummary: string, assessmentCriteria: string[]) {
  const arr = Array.isArray(value) ? value : []
  const content = arr.map((x: any) => ({
    heading: cleanText(x?.heading, 140) || 'محور دراسي',
    body: cleanText(x?.body, 900) || fallbackSummary,
  })).filter((x) => x.heading && x.body).slice(0, 6)
  if (content.length) return content
  return [
    { heading: 'محاور الوحدة', body: fallbackSummary || 'محاور دراسية مقترحة من الكتب وبنك المعرفة.' },
    { heading: 'معايير التقييم', body: assessmentCriteria.join('، ') || 'يقاس فهم الطالب من خلال أسئلة تطبيقية وربط نظري/عملي.' },
  ]
}

function fallbackUnits(program: any, semestersCount: number) {
  const unitsPerSemester = 4
  const base = ['مدخل تأسيسي', 'مفاهيم ونظريات', 'تطبيقات عملية', 'تقييم وبحث تطبيقي']
  const units: any[] = []
  for (let semester = 1; semester <= semestersCount; semester++) {
    for (let i = 0; i < unitsPerSemester; i++) {
      units.push({
        semester,
        title: `${base[i]} في ${program.titleAr}`,
        summary: `وحدة مقترحة لتنظيم دراسة ${program.titleAr} ضمن الفصل ${semester}.`,
        objectives: ['فهم المفاهيم الأساسية', 'تحليل التطبيقات العملية', 'ربط المعرفة بالواقع المهني'],
        content: [{ heading: 'محتوى الوحدة', body: `تعالج هذه الوحدة جانباً أساسياً من برنامج ${program.titleAr}.` }],
        assessmentCriteria: ['فهم المفاهيم', 'التحليل التطبيقي', 'استخدام مصادر البرنامج'],
      })
    }
  }
  return units
}

async function generateUnitPlan(programId: string) {
  const program = await db.program.findUnique({
    where: { id: programId },
    include: {
      books: { select: { id: true, title: true, author: true, semester: true, description: true } },
      knowledgeItems: { select: { title: true, summary: true, keywords: true, importance: true }, orderBy: { importance: 'desc' }, take: 40 },
    },
  })
  if (!program) return null
  const semestersCount = Math.max(1, Math.min(8, Number(program.semestersCount || 2)))

  const booksText = program.books.map((b) => `- الفصل ${b.semester || 1}: ${b.title}${b.author ? ` — ${b.author}` : ''}${b.description ? ` | ${b.description}` : ''}`).join('\n') || 'لا توجد كتب مرفوعة بعد.'
  const knowledgeText = program.knowledgeItems.map((k, i) => `${i + 1}. ${k.title}: ${String(k.summary || '').slice(0, 420)}`).join('\n') || 'لا توجد عناصر بنك معرفة بعد.'

  let generated: any[] = []
  if (program.books.length || program.knowledgeItems.length) {
    const prompt = `
أنت مصمم مناهج جامعية محترف. اقترح خطة وحدات أكاديمية قابلة للمراجعة البشرية لبرنامج:
${program.titleAr}
التصنيف: ${program.category}
الوصف: ${program.description || 'غير محدد'}
عدد الفصول المطلوب: ${semestersCount}

الكتب/المراجع:
${booksText}

أهم عناصر بنك المعرفة:
${knowledgeText}

المطلوب إخراج JSON صالح فقط بالشكل:
{
  "semesters": [
    {
      "semester": 1,
      "units": [
        {
          "title": "عنوان الوحدة",
          "summary": "ملخص قصير",
          "objectives": ["هدف تعلم", "هدف تعلم"],
          "content": [{"heading":"محور", "body":"شرح مختصر"}],
          "bookTitles": ["اسم كتاب مرتبط"],
          "assessmentCriteria": ["معيار اختبار أو واجب"]
        }
      ]
    }
  ]
}

قواعد مهمة:
- اقترح 3 إلى 5 وحدات لكل فصل.
- لا تعتمد وحدات عامة جداً؛ اربطها بعناوين الكتب وبنك المعرفة.
- اجعل الأهداف قابلة للقياس.
- اجعل معايير الاختبارات واضحة.
- لا تكتب Markdown ولا شرحاً خارج JSON.`

    try {
      const raw = await geminiCompleteJson({
        system: 'أنت مصمم مناهج أكاديمية. أرجع JSON صالحاً فقط، دون أي نص خارج JSON.',
        history: [{ role: 'user', text: prompt }],
        temperature: 0.25,
        thinkingBudget: 256,
        maxOutputTokens: 6000,
      })
      const parsed = parseJsonObject(raw)
      generated = Array.isArray(parsed?.semesters)
        ? parsed.semesters.flatMap((s: any) => (Array.isArray(s?.units) ? s.units.map((u: any) => ({ ...u, semester: Number(s.semester || u.semester || 1) })) : []))
        : []
    } catch (e) {
      console.error('unit plan ai failed:', e)
    }
  }

  if (!generated.length) generated = fallbackUnits(program, semestersCount)

  const cleaned = generated.map((u: any, idx: number) => {
    const semester = Math.max(1, Math.min(semestersCount, Number(u.semester || Math.floor(idx / 4) + 1)))
    const title = cleanText(u.title, 180) || `وحدة ${idx + 1}`
    const summary = cleanText(u.summary, 900) || `وحدة مقترحة ضمن برنامج ${program.titleAr}.`
    const objectives = safeObjectives(u.objectives)
    const assessmentCriteria = safeObjectives(u.assessmentCriteria)
    return {
      semester,
      title,
      summary,
      objectives: objectives.length ? objectives : ['فهم المفاهيم الأساسية', 'تطبيق المعرفة في سياق مهني', 'الاستعداد للتقييم الأكاديمي'],
      content: safeContent(u.content, summary, assessmentCriteria),
      assessmentCriteria,
      bookTitles: Array.isArray(u.bookTitles) ? u.bookTitles.map((x: any) => cleanText(x, 180)).filter(Boolean).slice(0, 4) : [],
    }
  }).filter((u) => u.title && u.summary).slice(0, Math.max(semestersCount * 5, 6))

  return { program, semestersCount, units: cleaned }
}

// POST /api/admin/program-units/suggest — يقترح ويحفظ وحدات قابلة للمراجعة البشرية
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const replace = body?.replace === true
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const plan = await generateUnitPlan(programId)
    if (!plan) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    if (replace) await db.unit.deleteMany({ where: { programId } })
    const currentCount = await db.unit.count({ where: { programId } })
    if (currentCount > 0 && !replace) {
      return NextResponse.json({
        error: 'توجد وحدات حالية لهذا البرنامج. استخدم خيار الاستبدال إذا أردت إعادة توليد الخطة.',
        existingUnits: currentCount,
      }, { status: 409 })
    }

    const created = await Promise.all(plan.units.map((u, idx) => db.unit.create({
      data: {
        programId,
        order: idx + 1,
        title: u.title,
        summary: `${u.summary}${u.bookTitles.length ? `\n\nالكتب المرتبطة: ${u.bookTitles.join('، ')}` : ''}${u.assessmentCriteria.length ? `\n\nمعايير التقييم: ${u.assessmentCriteria.join('، ')}` : ''}`.slice(0, 3000),
        objectives: JSON.stringify(u.objectives),
        content: JSON.stringify(u.content),
      },
    })))

    await db.program.update({
      where: { id: programId },
      data: {
        semestersCount: plan.semestersCount,
        academicReadinessStatus: 'READY_FOR_REVIEW',
        academicApproved: false,
        academicApprovedAt: null,
        academicApprovedById: null,
      },
    })

    await audit({ id: admin.id, name: admin.name }, 'GENERATE_CURRICULUM_UNITS', 'Program', programId, `اقتراح ${created.length} وحدة منهجية لبرنامج ${plan.program.titleAr}${replace ? ' مع استبدال الوحدات السابقة' : ''}`)

    return NextResponse.json({ ok: true, count: created.length, units: created })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('suggest program units error:', e)
    return NextResponse.json({ error: 'تعذر اقتراح وحدات البرنامج' }, { status: 500 })
  }
}
