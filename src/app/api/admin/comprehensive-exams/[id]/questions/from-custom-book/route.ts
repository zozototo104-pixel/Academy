import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  CUSTOM_BOOK_MAX_FILE_BYTES,
  CUSTOM_BOOK_MAX_PAGES,
  clampCustomBookQuestionCount,
  extractCustomBookChunks,
  generateCustomBookQuestions,
} from '@/lib/comprehensive-exam-custom-book'

export const runtime = 'nodejs'
export const maxDuration = 300

function extOf(name: string) {
  const parts = String(name || '').toLowerCase().split('.')
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

function extractionErrorMessage(code: string, fileName: string): string {
  const isDocx = extOf(fileName) === 'docx'
  if (code === 'CUSTOM_BOOK_NOT_A_PDF') return 'الملف ليس PDF صالحاً — ارفع كتاباً بصيغة PDF'
  if (code === 'CUSTOM_BOOK_DOCX_UNREADABLE') return 'تعذرت قراءة ملف Word — الملف تالف أو ليس DOCX صالحاً'
  if (code === 'CUSTOM_BOOK_EMPTY_PDF') return 'ملف PDF بلا صفحات'
  if (code === 'CUSTOM_BOOK_TOO_LONG')
    return isDocx
      ? `الملف أطول من ${CUSTOM_BOOK_MAX_PAGES} مقطعاً نصياً — للملفات الطويلة ارفع الكتاب ككتاب برنامج أولاً ثم استورد أسئلته من بنك الأسئلة`
      : `الكتاب أطول من ${CUSTOM_BOOK_MAX_PAGES} صفحة — للكتب الطويلة ارفع الكتاب ككتاب برنامج أولاً ثم استورد أسئلته من بنك الأسئلة`
  return `تعذرت قراءة الكتاب «${fileName}»`
}

// POST /api/admin/comprehensive-exams/[id]/questions/from-custom-book
// رفع كتاب PDF مخصص (ليس من كتب البرنامج) وتوليد أسئلة منه. الكتاب
// لا يُسجَّل ككتاب برنامج: يُقرأ في الذاكرة فقط، وتُحفظ الأسئلة
// المولَّدة فقط — كلها بانتظار المراجعة. الصفحات بلا نص مقروء
// (ممسوحة ضوئياً أو مشوّهة) تُبلَّغ بأرقامها ولا تُسكت عنها.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, programId: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const form = await req.formData()
    const file = form.get('file') as unknown as File | null
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'ارفع كتاباً بصيغة PDF أو Word (DOCX)' }, { status: 400 })
    }
    const fileName = file.name || 'book.pdf'
    const ext = extOf(fileName)
    if (ext === 'doc') {
      return NextResponse.json({ error: 'صيغة DOC القديمة غير مدعومة — احفظ الملف بصيغة DOCX أو PDF ثم ارفعه' }, { status: 400 })
    }
    if (ext !== 'pdf' && ext !== 'docx') {
      return NextResponse.json({ error: 'الصيغة غير مدعومة — المسموح: PDF أو Word (DOCX) فقط' }, { status: 400 })
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.length > CUSTOM_BOOK_MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'حجم الكتاب يتجاوز 10 ميغابايت' }, { status: 400 })
    }
    const count = clampCustomBookQuestionCount(form.get('count'))
    let extraction
    try {
      extraction = await extractCustomBookChunks(buffer, fileName)
    } catch (e: any) {
      return NextResponse.json({ error: extractionErrorMessage(String(e?.message || e), fileName) }, { status: 422 })
    }
    if (!extraction.chunks.length) {
      const isDocx = extOf(fileName) === 'docx'
      return NextResponse.json(
        {
          error:
            extraction.totalPages === extraction.unreadablePages.length
              ? isDocx
                ? 'لم أجد نصاً مقروءاً في ملف Word — الملف فارغ أو نصه صور فقط؛ جرّب نسخة نصية من الملف'
                : 'لم أجد نصاً مقروءاً في الكتاب — كل صفحاته بلا نص (ممسوح ضوئياً على الأرجح)؛ جرّب نسخة نصية من الكتاب'
              : 'لم أجد مقاطع صالحة لتوليد أسئلة من هذا الكتاب',
          extraction: {
            bookTitle: extraction.bookTitle,
            kind: extraction.kind || (isDocx ? 'DOCX' : 'PDF'),
            totalPages: extraction.totalPages,
            readablePages: extraction.readablePages,
            unreadablePages: extraction.unreadablePages,
          },
        },
        { status: 422 },
      )
    }
    const program = await db.program.findUnique({ where: { id: exam.programId }, select: { titleAr: true } })
    const previous = await db.comprehensiveExamQuestion.findMany({
      where: { examId: id },
      select: { text: true },
      orderBy: { order: 'asc' },
      take: 80,
    })
    let generated
    try {
      generated = await generateCustomBookQuestions(
        extraction,
        {
          programTitleAr: program?.titleAr || exam.title,
          count,
          previousQuestionTexts: previous.map((q: any) => q.text),
        },
      )
    } catch (e: any) {
      if (e?.code === 'INSUFFICIENT_SOURCE') {
        return NextResponse.json(
          {
            error: String(e?.message || 'مصادر الكتاب غير كافية لتوليد أسئلة موثّقة'),
            extraction: {
              bookTitle: extraction.bookTitle,
              kind: extraction.kind || (extOf(fileName) === 'docx' ? 'DOCX' : 'PDF'),
              totalPages: extraction.totalPages,
              readablePages: extraction.readablePages,
              unreadablePages: extraction.unreadablePages,
            },
          },
          { status: 422 },
        )
      }
      console.error('comprehensive exam custom-book generation error:', e)
      return NextResponse.json({ error: `تعذر توليد الأسئلة من الكتاب: ${String(e?.message || e).slice(0, 300)}` }, { status: 502 })
    }
    if (!generated.questions.length) {
      return NextResponse.json(
        {
          error: 'لم ينجُ أي سؤال مولَّد من التحقق بالدليل — جرّب كتاباً بنص أوضح أو عدّداً أقل من الأسئلة',
          rejected: generated.rejected,
          rejectedCount: generated.rejectedCount,
          extraction: {
            bookTitle: extraction.bookTitle,
            kind: extraction.kind || (extOf(fileName) === 'docx' ? 'DOCX' : 'PDF'),
            totalPages: extraction.totalPages,
            readablePages: extraction.readablePages,
            unreadablePages: extraction.unreadablePages,
          },
        },
        { status: 422 },
      )
    }
    const last = await db.comprehensiveExamQuestion.findFirst({
      where: { examId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    let order = last?.order ?? 0
    await db.comprehensiveExamQuestion.createMany({
      data: generated.questions.map((q) => ({
        examId: id,
        order: ++order,
        type: q.type,
        text: q.text,
        options: JSON.stringify(q.options),
        correctAnswer: q.correctAnswer,
        source: 'CUSTOM_BOOK',
        sourceBookId: extraction.bookId,
        sourceEvidence: q.sourceEvidence,
        status: 'PENDING_REVIEW',
        createdById: admin.id,
      })),
    })
    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_COMPREHENSIVE_EXAM_QUESTIONS_FROM_CUSTOM_BOOK',
      'ComprehensiveExam',
      id,
      `توليد ${generated.questions.length} سؤالاً من كتاب مخصص «${extraction.bookTitle}» (${extraction.totalPages} ${extraction.kind === 'DOCX' ? 'مقطعاً نصياً' : 'صفحة'}، ${extraction.readablePages} ${extraction.kind === 'DOCX' ? 'مقروءاً' : 'مقروءة'}) إلى الامتحان الشامل «${exam.title}» — كلها بانتظار المراجعة؛ ${generated.rejectedCount} سؤالاً مرفوضاً بالتحقق`,
    )
    return NextResponse.json({
      ok: true,
      source: 'CUSTOM_BOOK',
      imported: generated.questions.length,
      requested: generated.requested,
      accepted: generated.accepted,
      rejected: generated.rejected,
      rejectedCount: generated.rejectedCount,
      provider: generated.provider || null,
      model: generated.model || null,
      extraction: {
        bookTitle: extraction.bookTitle,
        kind: extraction.kind || (extOf(fileName) === 'docx' ? 'DOCX' : 'PDF'),
        totalPages: extraction.totalPages,
        readablePages: extraction.readablePages,
        unreadablePages: extraction.unreadablePages,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam custom-book error:', e)
    return NextResponse.json({ error: 'تعذر توليد الأسئلة من الكتاب المخصص' }, { status: 500 })
  }
}
