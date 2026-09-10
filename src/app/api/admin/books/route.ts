import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { extractDocumentText } from '@/lib/document-extract'
import { rebuildKnowledgeForBook } from '@/lib/knowledge-bank'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_BOOK_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_BOOK_TEXT_CHARS = 180000

/** استخراج نص من ملف PDF — احتياطي قديم؛ المسار الأساسي يستخدم extractDocumentText لكل الصيغ */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      const text = (result?.text || '').replace(/\s+/g, ' ').trim()
      return text.slice(0, 40000)
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch (e) {
    console.error('pdf parse error:', e)
    return ''
  }
}

/** جلب محتوى رابط الكتاب من الإنترنت واستخراج نصه ليقرأه خبير الذكاء الاصطناعي (PDF أو صفحة HTML) */
async function fetchLinkContent(url: string): Promise<{ ok: boolean; mime: string; buffer?: Buffer; htmlText?: string; note?: string }> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (AACT-Academy-Platform; book-indexing)' },
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, mime: '', note: `الرابط أعاد حالة ${res.status}` }
    const mime = res.headers.get('content-type') || ''
    if (mime.includes('pdf')) {
      const arr = await res.arrayBuffer()
      if (arr.byteLength > MAX_BOOK_SIZE) return { ok: false, mime, note: 'حجم الملف على الرابط يتجاوز 10 ميجابايت' }
      return { ok: true, mime, buffer: Buffer.from(arr) }
    }
    if (mime.includes('text/') || mime.includes('html')) {
      const html = await res.text()
      // استخراج نص الصفحة: إزالة السكربتات والأنماط والوسوم
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
      return { ok: true, mime, htmlText: text.slice(0, MAX_BOOK_TEXT_CHARS) }
    }
    return { ok: false, mime, note: 'نوع المحتوى غير مدعوم للاستخراج الآلي (الرابط يبقى متاحاً للطلاب للقراءة)' }
  } catch (e: any) {
    return { ok: false, mime: '', note: `تعذر الوصول للرابط: ${String(e?.message || e).slice(0, 100)}` }
  }
}

// GET /api/admin/books?programId=xxx — قائمة الكتب المقررة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId')
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const books = await db.book.findMany({
      where: { programId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, title: true, titleEn: true, author: true, year: true, description: true,
        fileName: true, mimeType: true, size: true, source: true, semester: true, link: true,
        createdAt: true,
      },
    })
    return NextResponse.json({ books: books.map((b) => ({ ...b, hasFile: !!b.fileName })) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin books GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الكتب' }, { status: 500 })
  }
}

// POST /api/admin/books — إضافة كتاب (اسم أو ملف مرفوع)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const form = await req.formData()
    const programId = String(form.get('programId') || '')
    const title = String(form.get('title') || '').trim()
    if (!programId || !title) {
      return NextResponse.json({ error: 'اسم الكتاب والبرنامج مطلوبان' }, { status: 400 })
    }

    const program = await db.program.findUnique({ where: { id: programId } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const file = form.get('file') as File | null
    const linkRaw = String(form.get('link') || '').trim()
    let link: string | null = null
    let fileName: string | null = null
    let mimeType: string | null = null
    let size: number | null = null
    let data: string | null = null
    let textContent: string | null = null
    let linkNote: string | null = null

    // رابط الكتاب على الإنترنت (بديل أو مكمّل للملف المرفوع) — يُجلب نصه آلياً ليقرأه خبير الذكاء الاصطناعي
    if (linkRaw) {
      try {
        const u = new URL(linkRaw)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
        link = linkRaw.slice(0, 600)
      } catch {
        return NextResponse.json({ error: 'رابط الكتاب غير صالح — يجب أن يبدأ بـ http:// أو https://' }, { status: 400 })
      }
      if (!file || file.size === 0) {
        const fetched = await fetchLinkContent(link!)
        if (fetched.ok && fetched.buffer) {
          mimeType = fetched.mime || 'application/octet-stream'
          fileName = fetched.buffer ? (link!.split('/').pop() || 'book-file').slice(0, 180) : null
          size = fetched.buffer.length
          const extracted = await extractDocumentText(fetched.buffer, mimeType, fileName, MAX_BOOK_TEXT_CHARS)
          textContent = extracted.text || null
          linkNote = extracted.readable ? extracted.note : `الرابط محفوظ، لكن لم نستخرج نصاً كافياً: ${extracted.note}`
        } else if (fetched.ok && fetched.htmlText) {
          textContent = fetched.htmlText
          linkNote = 'تم استخراج نص الصفحة من الرابط'
        } else {
          linkNote = fetched.note || 'تعذر استخراج نص آلي من الرابط — الرابط محفوظ للطلاب'
        }
      }
    }

    if (file && file.size > 0) {
      if (file.size > MAX_BOOK_SIZE) {
        return NextResponse.json({ error: 'حجم الملف يتجاوز 10 ميجابايت' }, { status: 400 })
      }
      const buf = Buffer.from(await file.arrayBuffer())
      fileName = file.name
      mimeType = file.type || 'application/octet-stream'
      size = file.size
      data = buf.toString('base64')
      const extracted = await extractDocumentText(buf, mimeType, fileName, MAX_BOOK_TEXT_CHARS)
      if (extracted.text) textContent = extracted.text
      if (!extracted.readable) {
        linkNote = extracted.note
      }
    }

    const semRaw = String(form.get('semester') || '')
    const semester = semRaw === '1' ? 1 : semRaw === '2' ? 2 : null

    const bookAuthor = String(form.get('author') || '').trim().slice(0, 200) || null
    const book = await db.book.create({
      data: {
        programId,
        title: title.slice(0, 300),
        titleEn: String(form.get('titleEn') || '').trim().slice(0, 300) || null,
        author: bookAuthor,
        year: String(form.get('year') || '').trim().slice(0, 20) || null,
        description: String(form.get('description') || '').trim().slice(0, 1000) || null,
        fileName, mimeType, size, data, textContent,
        link,
        semester,
        source: 'ADMIN',
      },
    })

    await audit({ id: admin.id, name: admin.name }, 'ADD_BOOK', 'Book', book.id, `إضافة كتاب مقرر: ${title} إلى ${program.titleAr}`)

    // إدراج الكتاب للطلاب المسجلين في البرنامج: إشعار الجميع بقراءته استعداداً للاختبار الشامل
    const enrolled = await db.enrollment.findMany({
      where: { programId, status: 'ACTIVE' },
      select: { userId: true },
    })
    for (const e of enrolled) {
      await notify(
        e.userId,
        'GENERAL',
        'كتاب مقرر جديد لبرنامجك — اقرأه استعداداً للاختبار',
        `أدرجت الإدارة كتاباً مقرراً جديداً في «${program.titleAr}»: «${title}»${bookAuthor ? ' للمؤلف ' + bookAuthor : ''}. اقرأه من تبويب «الكتب المقررة» في بوابة الطالب — يبني خبير الذكاء الاصطناعي امتحان الفصل عليه.`,
        'dashboard'
      )
    }

    return NextResponse.json({
      ok: true,
      book: { id: book.id, title: book.title, author: book.author, fileName: book.fileName, link: book.link, source: book.source },
      textExtracted: !!textContent,
      linkNote,
      notifiedStudents: enrolled.length,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin books POST error:', e)
    return NextResponse.json({ error: 'تعذر إضافة الكتاب' }, { status: 500 })
  }
}

// DELETE /api/admin/books?bookId=xxx — حذف كتاب
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const bookId = req.nextUrl.searchParams.get('bookId')
    if (!bookId) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })
    const book = await db.book.delete({ where: { id: bookId } })
    await audit({ id: admin.id, name: admin.name }, 'DELETE_BOOK', 'Book', bookId, `حذف كتاب مقرر: ${book.title}`)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin books DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الكتاب' }, { status: 500 })
  }
}
