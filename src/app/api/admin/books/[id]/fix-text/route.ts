import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'

export const runtime = 'nodejs'
export const maxDuration = 300
type Context = { params: Promise<{ id: string }> }

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function fixNullableText(value: string | null | undefined) {
  if (value == null) return value
  return fixArabicPdfText(value)
}

function fixOptionsJson(value: string | null | undefined) {
  if (value == null) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return JSON.stringify(parsed.map((item) => typeof item === 'string' ? fixArabicPdfText(item) : item))
  } catch {
    // If options were stored as a non-JSON legacy string, fix only the text itself.
  }
  return fixArabicPdfText(value)
}

function changed<T extends string | null | undefined>(before: T, after: T) {
  return before !== after
}

export async function POST(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })

    const result = await db.$transaction(async (tx) => {
      let chunksUpdated = 0
      let knowledgeItemsUpdated = 0
      let questionsUpdated = 0
      let examQuestionsUpdated = 0
      let unitsUpdated = 0
      let studyGuidesUpdated = 0

      const chunks = await tx.bookChunk.findMany({ where: { bookId: id }, select: { id: true, text: true } })
      for (const chunk of chunks) {
        const fixed = fixArabicPdfText(chunk.text)
        if (!changed(chunk.text, fixed)) continue
        await tx.bookChunk.update({ where: { id: chunk.id }, data: { text: fixed, contentHash: sha256(fixed), charCount: fixed.length } })
        chunksUpdated += 1
      }

      const knowledgeItems = await tx.bookKnowledgeItem.findMany({
        where: { bookId: id },
        select: { id: true, title: true, summary: true, excerpt: true, keywords: true, sourceNote: true, textProvenance: true },
      })
      for (const item of knowledgeItems) {
        const data: { title?: string; summary?: string; excerpt?: string | null; keywords?: string | null; sourceNote?: string | null; textProvenance?: string | null } = {}
        const title = fixArabicPdfText(item.title)
        const summary = fixArabicPdfText(item.summary)
        const excerpt = fixNullableText(item.excerpt)
        const keywords = fixNullableText(item.keywords)
        const sourceNote = fixNullableText(item.sourceNote)
        const textProvenance = fixNullableText(item.textProvenance)
        if (changed(item.title, title)) data.title = title
        if (changed(item.summary, summary)) data.summary = summary
        if (changed(item.excerpt, excerpt)) data.excerpt = excerpt
        if (changed(item.keywords, keywords)) data.keywords = keywords
        if (changed(item.sourceNote, sourceNote)) data.sourceNote = sourceNote
        if (changed(item.textProvenance, textProvenance)) data.textProvenance = textProvenance
        if (!Object.keys(data).length) continue
        await tx.bookKnowledgeItem.update({ where: { id: item.id }, data })
        knowledgeItemsUpdated += 1
      }

      const questions = await tx.questionBankItem.findMany({
        where: { bookId: id },
        select: { id: true, text: true, options: true, modelAnswer: true, sourceEvidence: true },
      })
      for (const question of questions) {
        const data: { text?: string; options?: string | null; modelAnswer?: string | null; sourceEvidence?: string | null } = {}
        const text = fixArabicPdfText(question.text)
        const options = fixOptionsJson(question.options)
        const modelAnswer = fixNullableText(question.modelAnswer)
        const sourceEvidence = fixOptionsJson(question.sourceEvidence)
        if (changed(question.text, text)) data.text = text
        if (changed(question.options, options)) data.options = options
        if (changed(question.modelAnswer, modelAnswer)) data.modelAnswer = modelAnswer
        if (changed(question.sourceEvidence, sourceEvidence)) data.sourceEvidence = sourceEvidence
        if (!Object.keys(data).length) continue
        await tx.questionBankItem.update({ where: { id: question.id }, data })
        questionsUpdated += 1
      }

      const units = await tx.unit.findMany({ where: { sourceBookId: id }, select: { id: true, title: true, summary: true, content: true, objectives: true } })
      const unitIds = units.map((unit) => unit.id)
      for (const unit of units) {
        const data: { title?: string; summary?: string | null; content?: string; objectives?: string | null } = {}
        const title = fixArabicPdfText(unit.title)
        const summary = fixNullableText(unit.summary)
        const content = fixArabicPdfText(unit.content)
        const objectives = fixNullableText(unit.objectives)
        if (changed(unit.title, title)) data.title = title
        if (changed(unit.summary, summary)) data.summary = summary
        if (changed(unit.content, content)) data.content = content
        if (changed(unit.objectives, objectives)) data.objectives = objectives
        if (!Object.keys(data).length) continue
        await tx.unit.update({ where: { id: unit.id }, data })
        unitsUpdated += 1
      }

      const studyGuides = unitIds.length
        ? await tx.programStudyGuide.findMany({
            where: { unitId: { in: unitIds } },
            select: { id: true, title: true, overview: true, objectives: true, keyTerms: true, sections: true, activities: true, discussionQuestions: true },
          })
        : []
      for (const guide of studyGuides) {
        const data: { title?: string; overview?: string; objectives?: string | null; keyTerms?: string | null; sections?: string | null; activities?: string | null; discussionQuestions?: string | null } = {}
        const title = fixArabicPdfText(guide.title)
        const overview = fixArabicPdfText(guide.overview)
        const objectives = fixNullableText(guide.objectives)
        const keyTerms = fixNullableText(guide.keyTerms)
        const sections = fixNullableText(guide.sections)
        const activities = fixNullableText(guide.activities)
        const discussionQuestions = fixNullableText(guide.discussionQuestions)
        if (changed(guide.title, title)) data.title = title
        if (changed(guide.overview, overview)) data.overview = overview
        if (changed(guide.objectives, objectives)) data.objectives = objectives
        if (changed(guide.keyTerms, keyTerms)) data.keyTerms = keyTerms
        if (changed(guide.sections, sections)) data.sections = sections
        if (changed(guide.activities, activities)) data.activities = activities
        if (changed(guide.discussionQuestions, discussionQuestions)) data.discussionQuestions = discussionQuestions
        if (!Object.keys(data).length) continue
        await tx.programStudyGuide.update({ where: { id: guide.id }, data })
        studyGuidesUpdated += 1
      }

      const exams = unitIds.length ? await tx.exam.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } }) : []
      const examIds = exams.map((exam) => exam.id)
      const examQuestions = examIds.length
        ? await tx.question.findMany({ where: { examId: { in: examIds } }, select: { id: true, text: true, options: true, modelAnswer: true } })
        : []
      for (const question of examQuestions) {
        const data: { text?: string; options?: string | null; modelAnswer?: string | null } = {}
        const text = fixArabicPdfText(question.text)
        const options = fixOptionsJson(question.options)
        const modelAnswer = fixNullableText(question.modelAnswer)
        if (changed(question.text, text)) data.text = text
        if (changed(question.options, options)) data.options = options
        if (changed(question.modelAnswer, modelAnswer)) data.modelAnswer = modelAnswer
        if (!Object.keys(data).length) continue
        await tx.question.update({ where: { id: question.id }, data })
        examQuestionsUpdated += 1
      }

      return { chunksUpdated, knowledgeItemsUpdated, questionsUpdated, examQuestionsUpdated, unitsUpdated, studyGuidesUpdated }
    }, { timeout: 120000, maxWait: 10000 })

    return NextResponse.json(result)
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('book fix-text error:', error)
    return NextResponse.json({ error: 'تعذر تصحيح النص العربي' }, { status: 500 })
  }
}
