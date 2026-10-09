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

async function cleanupUpload(uploadId: string, userId: string, thesisId: string) {
  await db.thesisUploadChunk.deleteMany({ where: { uploadId, userId, thesisId } })
}

async function rejectIfUploadOwnedByAnother(uploadId: string, userId: string, thesisId: string) {
  const foreign = await db.thesisUploadChunk.findFirst({
    where: { uploadId, OR: [{ userId: { not: userId } }, { thesisId: { not: thesisId } }] },
    select: { id: true },
  })
  return !!foreign
}

export async function POST(req: NextRequest) {
  let cleanupUploadId = ''
  let cleanupUserId = ''
  let cleanupThesisId = ''
  try {
    const user = await requireUser()
    cleanupUserId = user.id
    await db.thesisUploadChunk.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    const form = await req.formData()
    const thesisId = clean(form.get('thesisId'), 100)
    const uploadId = clean(form.get('uploadId'), 120)
    cleanupThesisId = thesisId
    cleanupUploadId = uploadId
    const index = Number(form.get('index'))
    const total = Number(form.get('total'))
    const complete = String(form.get('complete') || '') === '1'
    const cancel = String(form.get('cancel') || form.get('abort') || '') === '1'
    const fileName = clean(form.get('fileName'), 220)
    const mimeType = clean(form.get('mimeType'), 180)
    if (!thesisId || !uploadId || !Number.isInteger(total) || total <= 0) return NextResponse.json({ error: 'بيانات الرفع غير مكتملة' }, { status: 400 })
    const thesis = await ownedThesis(user.id, thesisId)
    if (!thesis) return NextResponse.json({ error: 'الأطروحة غير موجودة' }, { status: 404 })
    if (await rejectIfUploadOwnedByAnother(uploadId, user.id, thesisId)) return NextResponse.json({ error: 'معرف الرفع لا يخص هذه الأطروحة' }, { status: 403 })
    if (thesis.status === 'SCHEDULED' || thesis.status === 'RESULT_APPROVED') return NextResponse.json({ error: 'لا يمكن رفع ملف جديد بعد جدولة المناقشة' }, { status: 409 })
    if (!ALLOWED_STATUSES.includes(thesis.status)) return NextResponse.json({ error: 'حالة البحث لا تسمح برفع ملف الآن' }, { status: 409 })
    if (cancel) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ ok: true, cancelled: true })
    }
    if (!complete) {
      const blob = form.get('chunk')
      if (!(blob instanceof File)) return NextResponse.json({ error: 'جزء الملف مفقود' }, { status: 400 })
      if (!Number.isInteger(index) || index < 0 || index >= total) return NextResponse.json({ error: 'ترتيب الجزء غير صالح' }, { status: 400 })
      const buffer = Buffer.from(await blob.arrayBuffer())
      if (!buffer.length || buffer.byteLength > MAX_SIZE) return NextResponse.json({ error: 'حجم الجزء غير صالح' }, { status: 413 })
      await db.thesisUploadChunk.upsert({
        where: { uploadId_index: { uploadId, index } },
        create: { uploadId, userId: user.id, thesisId, index, data: buffer.toString('base64') },
        update: { userId: user.id, thesisId, data: buffer.toString('base64') },
      })
      return NextResponse.json({ ok: true, index })
    }
    const rows = await db.thesisUploadChunk.findMany({ where: { uploadId, userId: user.id, thesisId }, orderBy: { index: 'asc' } })
    if (rows.length !== total) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ error: `لم تصل كل أجزاء الملف (${rows.length}/${total})` }, { status: 400 })
    }
    if (rows.some((row, i) => row.index !== i)) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ error: 'ترتيب أجزاء الملف غير مكتمل' }, { status: 400 })
    }
    const buffer = Buffer.concat(rows.map((row) => Buffer.from(row.data, 'base64')))
    if (buffer.byteLength > MAX_SIZE) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ error: 'حجم الملف يتجاوز 20MB' }, { status: 413 })
    }
    const finalMime = validateMagic(buffer, mimeType, fileName)
    if (!finalMime) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ error: 'يسمح فقط بملفات PDF أو DOCX صحيحة' }, { status: 400 })
    }
    let stored
    try {
      stored = await storeFileBuffer({ buffer, fileName, mimeType: finalMime, namespace: 'thesis' })
    } catch (error) {
      await cleanupUpload(uploadId, user.id, thesisId)
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
    }
    const updated = await db.$transaction(async (tx) => {
      await tx.thesisChunk.deleteMany({ where: { thesisId } })
      await tx.thesisUploadChunk.deleteMany({ where: { uploadId, userId: user.id, thesisId } })
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
          extractionLockedUntil: null,
          wordCount: null,
          pageCount: null,
          digest: Prisma.JsonNull,
          extractedAt: null,
        },
      })
    })
    return NextResponse.json({ ok: true, thesis: updated })
  } catch (error: any) {
    if (cleanupUploadId && cleanupUserId && cleanupThesisId) await cleanupUpload(cleanupUploadId, cleanupUserId, cleanupThesisId).catch(() => {})
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('thesis upload-chunk error:', error)
    return NextResponse.json({ error: 'تعذر رفع ملف البحث' }, { status: 500 })
  }
}
