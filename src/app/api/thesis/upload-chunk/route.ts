import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_SIZE = 20 * 1024 * 1024
const ALLOWED_STATUSES = ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED']

function clean(value: unknown, max = 220) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, max)
}

function key(uploadId: string, index: number) {
  return `THESIS_UPLOAD_CHUNK:${uploadId}:${index}`
}

function isPdf(buffer: Buffer) {
  return buffer.subarray(0, 4).toString() === '%PDF'
}

function isDocx(buffer: Buffer) {
  return buffer.subarray(0, 2).toString() === 'PK'
}

function validateMagic(buffer: Buffer, mimeType: string, fileName: string) {
  const lower = fileName.toLowerCase()
  const wantsPdf = mimeType.includes('pdf') || lower.endsWith('.pdf')
  const wantsDocx = mimeType.includes('wordprocessingml') || lower.endsWith('.docx')
  if (wantsPdf && isPdf(buffer)) return 'application/pdf'
  if (wantsDocx && isDocx(buffer)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return null
}

async function ownedThesis(userId: string, thesisId: string) {
  return db.thesisSubmission.findFirst({ where: { id: thesisId, userId } })
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const form = await req.formData()
    const thesisId = clean(form.get('thesisId'), 100)
    const uploadId = clean(form.get('uploadId'), 120)
    const index = Number(form.get('index'))
    const total = Number(form.get('total'))
    const complete = String(form.get('complete') || '') === '1'
    const cancel = String(form.get('cancel') || '') === '1'
    const fileName = clean(form.get('fileName'), 220)
    const mimeType = clean(form.get('mimeType'), 180)
    if (!thesisId || !uploadId || !Number.isInteger(total) || total <= 0) return NextResponse.json({ error: 'بيانات الرفع غير مكتملة' }, { status: 400 })
    const thesis = await ownedThesis(user.id, thesisId)
    if (!thesis) return NextResponse.json({ error: 'الأطروحة غير موجودة' }, { status: 404 })
    if (thesis.status === 'SCHEDULED' || thesis.status === 'RESULT_APPROVED') return NextResponse.json({ error: 'لا يمكن رفع ملف جديد بعد جدولة المناقشة' }, { status: 409 })
    if (!ALLOWED_STATUSES.includes(thesis.status)) return NextResponse.json({ error: 'حالة البحث لا تسمح برفع ملف الآن' }, { status: 409 })
    if (cancel) {
      await db.setting.deleteMany({ where: { key: { startsWith: `THESIS_UPLOAD_CHUNK:${uploadId}:` } } })
      return NextResponse.json({ ok: true, cancelled: true })
    }
    if (!complete) {
      const blob = form.get('chunk')
      if (!(blob instanceof File)) return NextResponse.json({ error: 'جزء الملف مفقود' }, { status: 400 })
      if (!Number.isInteger(index) || index < 0 || index >= total) return NextResponse.json({ error: 'ترتيب الجزء غير صالح' }, { status: 400 })
      const buffer = Buffer.from(await blob.arrayBuffer())
      if (!buffer.length || buffer.byteLength > MAX_SIZE) return NextResponse.json({ error: 'حجم الجزء غير صالح' }, { status: 413 })
      await db.setting.upsert({ where: { key: key(uploadId, index) }, create: { key: key(uploadId, index), value: buffer.toString('base64') }, update: { value: buffer.toString('base64') } })
      return NextResponse.json({ ok: true, index })
    }
    const rows = await db.setting.findMany({ where: { key: { startsWith: `THESIS_UPLOAD_CHUNK:${uploadId}:` } } })
    if (rows.length !== total) return NextResponse.json({ error: `لم تصل كل أجزاء الملف (${rows.length}/${total})` }, { status: 400 })
    const chunks = rows
      .map((row) => ({ index: Number(row.key.split(':').pop()), value: row.value }))
      .sort((a, b) => a.index - b.index)
    if (chunks.some((chunk, i) => chunk.index !== i)) return NextResponse.json({ error: 'ترتيب أجزاء الملف غير مكتمل' }, { status: 400 })
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.value, 'base64')))
    if (buffer.byteLength > MAX_SIZE) return NextResponse.json({ error: 'حجم الملف يتجاوز 20MB' }, { status: 413 })
    const finalMime = validateMagic(buffer, mimeType, fileName)
    if (!finalMime) return NextResponse.json({ error: 'يسمح فقط بملفات PDF أو DOCX صحيحة' }, { status: 400 })
    let stored
    try {
      stored = await storeFileBuffer({ buffer, fileName, mimeType: finalMime, namespace: 'thesis' })
    } catch (error) {
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
    }
    const updated = await db.$transaction(async (tx) => {
      await tx.thesisChunk.deleteMany({ where: { thesisId } })
      await tx.setting.deleteMany({ where: { key: { startsWith: `THESIS_UPLOAD_CHUNK:${uploadId}:` } } })
      return tx.thesisSubmission.update({
        where: { id: thesisId },
        data: {
          fileStorageProvider: stored.provider,
          fileStorageKey: stored.key,
          fileUrl: stored.url,
          fileName,
          fileMime: finalMime,
          fileSize: stored.size || buffer.byteLength,
          extractionStatus: 'UPLOADED',
          extractionError: null,
          extractionPagesDone: 0,
          extractionTotalPages: null,
          wordCount: null,
          pageCount: null,
          digest: Prisma.JsonNull,
          extractedAt: null,
        },
      })
    })
    return NextResponse.json({ ok: true, thesis: updated })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('thesis upload-chunk error:', error)
    return NextResponse.json({ error: 'تعذر رفع ملف البحث' }, { status: 500 })
  }
}
