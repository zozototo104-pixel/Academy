import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { storageErrorMessage, storeFileBuffer } from '@/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_BOOK_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_CHUNK_BASE64_LENGTH = 1_250_000 // يبقي كل طلب تحت حد Vercel بأمان

function cleanFileName(value: unknown) {
  return String(value || 'book-file').trim().slice(0, 180) || 'book-file'
}

function cleanMime(value: unknown) {
  return String(value || 'application/octet-stream').trim().slice(0, 120) || 'application/octet-stream'
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => null) as any
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'طلب الرفع غير صالح' }, { status: 400 })
    }

    const action = String(body.action || 'chunk')
    const bookId = String(body.bookId || '').trim()
    const uploadId = String(body.uploadId || '').trim()
    if (!bookId || !uploadId) {
      return NextResponse.json({ error: 'معرف الكتاب ومعرف الرفع مطلوبان' }, { status: 400 })
    }

    const book = await db.book.findUnique({ where: { id: bookId }, include: { program: true } })
    if (!book) return NextResponse.json({ error: 'الكتاب غير موجود' }, { status: 404 })

    if (action === 'abort') {
      await db.bookUploadChunk.deleteMany({ where: { bookId, uploadId } })
      return NextResponse.json({ ok: true })
    }

    if (action === 'complete') {
      const chunks = await db.bookUploadChunk.findMany({
        where: { bookId, uploadId },
        orderBy: { index: 'asc' },
      })
      if (!chunks.length) {
        return NextResponse.json({ error: 'لم تصل أجزاء الملف بعد' }, { status: 400 })
      }
      const total = chunks[0].total
      if (chunks.length !== total) {
        return NextResponse.json({ error: `وصل ${chunks.length} من ${total} أجزاء فقط` }, { status: 400 })
      }
      for (let i = 0; i < total; i++) {
        if (chunks[i]?.index !== i) {
          return NextResponse.json({ error: `الجزء رقم ${i + 1} مفقود أو غير مرتب` }, { status: 400 })
        }
      }

      const buffers = chunks.map((c) => Buffer.from(c.chunk, 'base64'))
      const fileBuffer = Buffer.concat(buffers)
      if (fileBuffer.byteLength > MAX_BOOK_SIZE) {
        await db.bookUploadChunk.deleteMany({ where: { bookId, uploadId } }).catch(() => {})
        return NextResponse.json({ error: 'حجم الملف يتجاوز 10 ميجابايت' }, { status: 400 })
      }

      const fileName = cleanFileName(chunks[0].fileName)
      const mimeType = cleanMime(chunks[0].mimeType)
      const updated = await db.book.update({
        where: { id: bookId },
        data: {
          fileName,
          mimeType,
          size: fileBuffer.byteLength,
          data: fileBuffer.toString('base64'),
          linkReadStatus: 'FILE_UPLOADED',
          linkReadNote: 'تم حفظ ملف الكتاب عبر رفع مجزأ آمن. اضغط بناء/تحديث بنك المعرفة ليتم التحليل والاستخراج.',
        },
      })

      await db.bookUploadChunk.deleteMany({ where: { bookId, uploadId } }).catch(() => {})
      await audit(
        { id: admin.id, name: admin.name },
        'UPLOAD_BOOK_FILE_CHUNKED',
        'Book',
        bookId,
        `رفع ملف كتاب مجزأ: ${fileName} إلى ${book.program.titleAr}`
      ).catch(() => {})

      return NextResponse.json({
        ok: true,
        book: {
          id: updated.id,
          title: updated.title,
          titleEn: updated.titleEn,
          author: updated.author,
          year: updated.year,
          description: updated.description,
          fileName: updated.fileName,
          mimeType: updated.mimeType,
          size: updated.size,
          link: updated.link,
          source: updated.source,
          semester: updated.semester,
          levelPolicy: updated.levelPolicy,
          readingDepth: updated.readingDepth,
          assessmentOrientation: updated.assessmentOrientation,
          linkReadStatus: updated.linkReadStatus,
          linkReadNote: updated.linkReadNote,
          hasFile: !!updated.fileName,
        },
      })
    }

    const index = Number(body.index)
    const total = Number(body.total)
    const size = Number(body.size || 0)
    const chunk = String(body.chunk || '')
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total) {
      return NextResponse.json({ error: 'ترقيم أجزاء الملف غير صالح' }, { status: 400 })
    }
    if (!chunk || chunk.length > MAX_CHUNK_BASE64_LENGTH) {
      return NextResponse.json({ error: 'حجم جزء الرفع كبير جداً' }, { status: 400 })
    }
    if (size > MAX_BOOK_SIZE) {
      return NextResponse.json({ error: 'حجم الملف يتجاوز 10 ميجابايت' }, { status: 400 })
    }

    await db.bookUploadChunk.upsert({
      where: { uploadId_index: { uploadId, index } },
      update: {
        bookId,
        total,
        fileName: cleanFileName(body.fileName),
        mimeType: cleanMime(body.mimeType),
        size: Number.isFinite(size) ? size : null,
        chunk,
      },
      create: {
        bookId,
        uploadId,
        index,
        total,
        fileName: cleanFileName(body.fileName),
        mimeType: cleanMime(body.mimeType),
        size: Number.isFinite(size) ? size : null,
        chunk,
      },
    })

    return NextResponse.json({ ok: true, index, total })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('book chunk upload error:', e)
    return NextResponse.json({ error: 'تعذر رفع جزء من ملف الكتاب' }, { status: 500 })
  }
}
