import { PDFDocument } from 'pdf-lib'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { extractNumberedPdfPages, pagesNeedingOcr, planBookChunks, transcribeScannedDocumentWithVision } from '@/lib/book-reader'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'
import { textAiComplete, textAiCompleteJson } from '@/lib/text-ai'
import { thesisDigestSchema } from '@/lib/thesis-digest'

export const runtime = 'nodejs'
export const maxDuration = 300

type Context = { params: Promise<{ id: string }> }

function words(text: string) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

function splitPlainTextToPages(text: string) {
  const normalized = String(text || '').replace(/\r/g, '').trim()
  const pages: Array<{ page: number; text: string; textProvenance: 'NATIVE_TEXT' }> = []
  for (let i = 0; i < normalized.length; i += 3500) pages.push({ page: pages.length + 1, text: normalized.slice(i, i + 3500), textProvenance: 'NATIVE_TEXT' })
  return pages.length ? pages : [{ page: 1, text: '', textProvenance: 'NATIVE_TEXT' as const }]
}

async function claim(thesisId: string) {
  const now = new Date()
  const lockedUntil = new Date(Date.now() + 60_000)
  const updated = await db.thesisSubmission.updateMany({
    where: { id: thesisId, OR: [{ extractionLockedUntil: null }, { extractionLockedUntil: { lt: now } }] },
    data: { extractionLockedUntil: lockedUntil },
  })
  return updated.count > 0
}

async function release(thesisId: string, error?: string) {
  await db.thesisSubmission.update({ where: { id: thesisId }, data: { extractionLockedUntil: null, ...(error ? { extractionStatus: 'FAILED', extractionError: error.slice(0, 1000) } : {}) } })
}

async function extractPdf(thesis: any, buffer: Buffer, deadlineMs: number) {
  const pdf = await PDFDocument.load(buffer)
  const totalPages = pdf.getPageCount()
  const pagesDone = Number(thesis.extractionPagesDone || 0)
  const last = Math.min(totalPages, pagesDone + 8)
  const nums = Array.from({ length: last - pagesDone }, (_, index) => pagesDone + index + 1)
  const extracted = await extractNumberedPdfPages(buffer, nums)
  const pageMap = new Map(extracted.map((page) => [page.page, page]))
  for (const range of pagesNeedingOcr(extracted)) {
    if (deadlineMs - Date.now() < 20_000) break
    const ocr = await transcribeScannedDocumentWithVision(buffer, range, deadlineMs)
    for (const page of ocr) pageMap.set(page.page, page)
  }
  const ordered = nums.map((page) => {
    const found = pageMap.get(page)
    if (!found) return { page, text: '', textProvenance: 'NATIVE_TEXT' as const }
    return found.textProvenance === 'NATIVE_TEXT' ? { ...found, text: fixArabicPdfText(found.text) } : found
  })
  const existing = await db.thesisChunk.count({ where: { thesisId: thesis.id } })
  const chunks = planBookChunks(ordered as any, 3000, 4000)
  await db.$transaction(async (tx) => {
    for (const chunk of chunks) {
      await tx.thesisChunk.upsert({
        where: { thesisId_index: { thesisId: thesis.id, index: existing + chunk.index } },
        create: { thesisId: thesis.id, index: existing + chunk.index, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, text: chunk.text, status: 'EXTRACTED' },
        update: { pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, text: chunk.text, status: 'EXTRACTED' },
      })
    }
    const batchWords = ordered.reduce((sum, page) => sum + words(page.text), 0)
    await tx.thesisSubmission.update({ where: { id: thesis.id }, data: { extractionStatus: last >= totalPages ? 'ANALYZING' : 'EXTRACTING', extractionPagesDone: last, extractionTotalPages: totalPages, pageCount: totalPages, wordCount: Number(thesis.wordCount || 0) + batchWords, extractionError: null } })
  })
  return { phase: last >= totalPages ? 'ANALYZING' : 'EXTRACTING', pagesDone: last, totalPages }
}

async function extractDocx(thesis: any, buffer: Buffer) {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  const pages = splitPlainTextToPages(result.value)
  const chunks = planBookChunks(pages as any, 3000, 4000)
  await db.$transaction(async (tx) => {
    await tx.thesisChunk.deleteMany({ where: { thesisId: thesis.id } })
    for (const chunk of chunks) await tx.thesisChunk.create({ data: { thesisId: thesis.id, index: chunk.index, pageStart: null, pageEnd: null, text: chunk.text, status: 'EXTRACTED' } })
    await tx.thesisSubmission.update({ where: { id: thesis.id }, data: { extractionStatus: 'ANALYZING', extractionPagesDone: pages.length, extractionTotalPages: pages.length, pageCount: pages.length, wordCount: words(result.value), extractionError: null } })
  })
  return { phase: 'ANALYZING', pagesDone: pages.length, totalPages: pages.length }
}

async function analyze(thesisId: string) {
  const chunks = await db.thesisChunk.findMany({ where: { thesisId, status: { in: ['EXTRACTED', 'FAILED'] }, attempts: { lt: 3 } }, orderBy: { index: 'asc' }, take: 3 })
  if (!chunks.length) {
    const failed = await db.thesisChunk.count({ where: { thesisId, status: 'FAILED' } })
    if (failed) throw new Error(`${failed} مقطع فشل`)
    await db.thesisSubmission.update({ where: { id: thesisId }, data: { extractionStatus: 'READY' } })
    return { phase: 'READY' }
  }
  for (const chunk of chunks) {
    try {
      const summary = await textAiComplete({
        taskLevel: 'ACADEMIC_DRAFT',
        temperature: 0.2,
        maxOutputTokens: 900,
        system: 'لخص مقطعاً من بحث تخرج أكاديمي بالعربية بوضوح وبدون اختلاق.',
        history: [{ role: 'user', text: `لخص هذا المقطع في 150-250 كلمة، مع ذكر: الفكرة، المنهج، النتائج، والادعاءات إن وجدت.\n\n${chunk.text.slice(0, 6000)}` }],
      })
      await db.thesisChunk.update({ where: { id: chunk.id }, data: { summary: summary.trim().slice(0, 1800), status: 'ANALYZED', attempts: { increment: 1 } } })
    } catch (error: any) {
      const attempts = chunk.attempts + 1
      await db.thesisChunk.update({ where: { id: chunk.id }, data: { attempts, status: attempts >= 3 ? 'FAILED' : 'EXTRACTED' } })
      if (attempts >= 3) throw new Error(`فشل تلخيص المقطع ${chunk.index}`)
    }
  }
  return { phase: 'ANALYZING', analyzed: chunks.length }
}

async function digest(thesisId: string) {
  const chunks = await db.thesisChunk.findMany({ where: { thesisId, status: 'ANALYZED' }, orderBy: { index: 'asc' }, select: { index: true, summary: true } })
  const summaries = chunks.map((chunk) => `#${chunk.index}\n${chunk.summary || ''}`).join('\n\n').slice(0, 14000)
  const raw = await textAiCompleteJson({
    taskLevel: 'ACADEMIC_CRITICAL',
    temperature: 0.1,
    maxOutputTokens: 2800,
    system: 'أنت محلل أبحاث أكاديمية. أرجع JSON فقط مطابقاً للمخطط المطلوب.',
    history: [{ role: 'user', text: `من ملخصات مقاطع بحث التخرج التالية، استخرج digest JSON بالمفاتيح: problem, objectives[], methodology, sample, tools[], keyFindings[], contributions[], literatureCoverage, referencesCount, weaknesses[], sectionMap[{title, chunkFrom, chunkTo}].\n\n${summaries}` }],
  })
  const match = raw.match(/\{[\s\S]*\}/)
  const parsed = digestSchema.parse(JSON.parse(match ? match[0] : raw))
  await db.thesisSubmission.update({ where: { id: thesisId }, data: { digest: parsed as any, extractionStatus: 'READY', extractedAt: new Date(), extractionError: null } })
  return { phase: 'READY', digest: parsed }
}

export async function POST(_req: NextRequest, context: Context) {
  const { id } = await context.params
  try {
    const user = await requireUser()
    const thesis = await db.thesisSubmission.findUnique({ where: { id } })
    if (!thesis) return NextResponse.json({ error: 'الأطروحة غير موجودة' }, { status: 404 })
    if (thesis.userId !== user.id && user.role !== 'ADMIN') return NextResponse.json({ error: 'غير مصرح' }, { status: 403 })
    const ok = await claim(id)
    if (!ok) return NextResponse.json({ ok: true, status: thesis.extractionStatus, locked: true })
    try {
      const deadlineMs = Date.now() + 50_000
      const current = await db.thesisSubmission.findUnique({ where: { id } })
      if (!current) throw new Error('THESIS_NOT_FOUND')
      let result: any
      if (!current.extractionStatus || ['UPLOADED', 'EXTRACTING'].includes(current.extractionStatus)) {
        const stored = await getFileBufferFromStorageOrBase64({ provider: current.fileStorageProvider, key: current.fileStorageKey, url: current.fileUrl, data: null, mimeType: current.fileMime })
        if (!stored?.buffer?.length) throw new Error('ملف البحث غير متوفر')
        if ((current.fileMime || '').includes('pdf') || stored.buffer.subarray(0, 4).toString() === '%PDF') result = await extractPdf(current, stored.buffer, deadlineMs)
        else result = await extractDocx(current, stored.buffer)
      } else if (current.extractionStatus === 'ANALYZING') {
        result = await analyze(id)
        const remaining = await db.thesisChunk.count({ where: { thesisId: id, status: 'EXTRACTED' } })
        const failed = await db.thesisChunk.count({ where: { thesisId: id, status: 'FAILED' } })
        if (!remaining && !failed) result = await digest(id)
        if (failed) throw new Error(`${failed} مقطع فشل`)
      } else if (current.extractionStatus === 'FAILED') {
        await db.thesisSubmission.update({ where: { id }, data: { extractionStatus: 'UPLOADED', extractionError: null, extractionPagesDone: 0 } })
        result = { phase: 'UPLOADED' }
      } else result = { phase: current.extractionStatus }
      await release(id)
      const updated = await db.thesisSubmission.findUnique({ where: { id }, select: { extractionStatus: true, extractionError: true, pageCount: true, wordCount: true, extractedAt: true, extractionPagesDone: true, extractionTotalPages: true } })
      return NextResponse.json({ ok: true, result, thesis: updated })
    } catch (error: any) {
      await release(id, String(error?.message || error))
      return NextResponse.json({ error: String(error?.message || error) }, { status: 500 })
    }
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('thesis process-step error:', error)
    return NextResponse.json({ error: 'تعذر معالجة البحث' }, { status: 500 })
  }
}
