import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ContentBlock = { heading: string; body: string }

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseUnitContent(value: unknown): ContentBlock[] {
  const blocks = parseJsonArray<any>(value)
  return blocks
    .map((item, index) => ({
      heading: cleanText(item?.heading, 120) || `محور ${index + 1}`,
      body: cleanText(item?.body, 700),
    }))
    .filter((item) => item.body.length > 20)
    .slice(0, 12)
}

function parseObjectives(value: unknown) {
  return parseJsonArray<any>(value)
    .map((item) => cleanText(item, 180))
    .filter((item) => item.length > 8)
    .slice(0, 10)
}

function sentenceFrom(text: string, fallback: string) {
  const cleaned = cleanText(text, 500)
  const parts = cleaned.split(/(?<=[.!؟])\s+|؛|\n/).map((x) => cleanText(x, 220)).filter((x) => x.length >= 35)
  return parts[0] || cleanText(cleaned, 220) || fallback
}

function optionSet(correct: string, distractors: string[]) {
  const seen = new Set<string>()
  const options = [correct, ...distractors]
    .map((x) => cleanText(x, 120))
    .filter((x) => x.length > 2 && !seen.has(x) && seen.add(x))
  while (options.length < 4) options.push(['جزئياً فقط', 'لا ينطبق على الوحدة', 'مفهوم خارج نطاق الوحدة', 'صياغة غير دقيقة'][options.length - 1] || 'خيار غير صحيح')
  return options.slice(0, 4)
}

function buildQuestions(unit: { title: string; summary?: string | null; content: string; objectives?: string | null }, count: number) {
  const blocks = parseUnitContent(unit.content)
  const objectives = parseObjectives(unit.objectives)
  const summary = sentenceFrom(unit.summary || '', unit.title)
  const sources = blocks.length ? blocks : [{ heading: unit.title, body: summary }]
  const requested = Math.max(3, Math.min(12, Number(count) || 6))
  const questions: Array<{ type: string; text: string; options: string[]; correctAnswer: string; modelAnswer: string; points: number }> = []

  const genericDistractors = [
    'التركيز على جانب إجرائي فقط دون ربطه بالمفهوم',
    'الاعتماد على الحفظ المجرد دون تطبيق',
    'تجاهل العلاقة بين المفاهيم والمحاور',
    'نقل معلومات غير مرتبطة بسياق الوحدة',
  ]

  for (let i = 0; i < requested; i++) {
    const block = sources[i % sources.length]
    const objective = objectives[i % Math.max(1, objectives.length)] || `استيعاب محور ${block.heading}`
    const evidence = sentenceFrom(block.body, summary)
    const isApplication = i % 3 === 2
    const isObjective = i % 3 === 0

    if (isObjective) {
      questions.push({
        type: 'MCQ',
        text: `ما الهدف التعليمي الأقرب إلى وحدة «${unit.title}»؟`,
        options: optionSet(objective, [
          'استبدال الفهم النظري بالحفظ الحرفي فقط',
          'تجاهل التطبيق العملي للمفاهيم',
          'التركيز على التعاريف المنعزلة دون سياق',
        ]),
        correctAnswer: '0',
        modelAnswer: `الإجابة الصحيحة ترتبط بهدف الوحدة: ${objective}.`,
        points: 10,
      })
      continue
    }

    if (isApplication) {
      questions.push({
        type: 'MCQ',
        text: `عند تطبيق محور «${block.heading}»، أي إجراء يعكس الفهم الأفضل لمحتوى الوحدة؟`,
        options: optionSet(`ربط المحور بالتطبيق العملي كما توضحه الوحدة: ${cleanText(evidence, 80)}`, genericDistractors),
        correctAnswer: '0',
        modelAnswer: `ينبغي ربط محور ${block.heading} بالتطبيق العملي لا بالاكتفاء بالحفظ.`,
        points: 10,
      })
      continue
    }

    questions.push({
      type: 'MCQ',
      text: `أي عبارة تعبّر بدقة عن محور «${block.heading}» في هذه الوحدة؟`,
      options: optionSet(cleanText(evidence, 110), genericDistractors),
      correctAnswer: '0',
      modelAnswer: `العبارة الصحيحة مستندة إلى محتوى الوحدة في محور ${block.heading}.`,
      points: 10,
    })
  }

  return questions
}

// POST /api/admin/unit-exams/generate
// body: { programId, unitId, count?, replace? }
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = cleanText(body?.programId, 80)
    const unitId = cleanText(body?.unitId, 80)
    const count = Math.max(3, Math.min(12, Number(body?.count || 6)))
    const replace = body?.replace !== false

    if (!programId || !unitId) {
      return NextResponse.json({ ok: false, error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    }

    const unit = await db.unit.findFirst({
      where: { id: unitId, programId },
      include: {
        program: { select: { id: true, titleAr: true } },
        exam: { select: { id: true, title: true, _count: { select: { questions: true, attempts: true } } } },
      },
    })

    if (!unit) return NextResponse.json({ ok: false, error: 'الوحدة غير موجودة ضمن البرنامج المحدد' }, { status: 404 })
    if (unit.exam?._count.attempts && replace && !body?.force) {
      return NextResponse.json({ ok: false, error: 'لا يمكن إعادة توليد اختبار وحدة لديه محاولات طلابية إلا بتأكيد force=true' }, { status: 409 })
    }

    const generated = buildQuestions(unit, count)
    if (generated.length < 3) {
      return NextResponse.json({ ok: false, error: 'محتوى الوحدة غير كافٍ لتوليد اختبار. أضف ملخصاً ومحاور محتوى ثم أعد المحاولة.' }, { status: 400 })
    }

    const result = await db.$transaction(async (tx) => {
      const exam = unit.exam
        ? await tx.exam.update({ where: { id: unit.exam.id }, data: { title: `اختبار وحدة: ${unit.title}`, passScore: 60 } })
        : await tx.exam.create({ data: { unitId: unit.id, title: `اختبار وحدة: ${unit.title}`, passScore: 60 } })

      if (replace) {
        await tx.question.deleteMany({ where: { examId: exam.id } })
      }

      const existingCount = replace ? 0 : await tx.question.count({ where: { examId: exam.id } })
      for (const [index, question] of generated.entries()) {
        await tx.question.create({
          data: {
            examId: exam.id,
            order: existingCount + index + 1,
            type: question.type,
            text: question.text,
            options: JSON.stringify(question.options),
            correctAnswer: question.correctAnswer,
            modelAnswer: question.modelAnswer,
            points: question.points,
          },
        })
      }

      await tx.program.update({
        where: { id: programId },
        data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null },
      })

      const fresh = await tx.exam.findUnique({
        where: { id: exam.id },
        select: { id: true, title: true, passScore: true, _count: { select: { questions: true, attempts: true } } },
      })
      return fresh
    })

    return NextResponse.json({
      ok: true,
      exam: result,
      message: unit.exam ? 'تمت إعادة توليد اختبار الوحدة' : 'تم توليد اختبار الوحدة',
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit exam generator error:', e)
    return NextResponse.json({ ok: false, error: 'تعذر توليد اختبار الوحدة' }, { status: 500 })
  }
}
