import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { extractDocumentText } from '@/lib/document-extract'
import {
  COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS,
  parseComprehensiveExamDocText,
  parseComprehensiveExamExcel,
} from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_FILE_BYTES = 10 * 1024 * 1024
const EXCEL_EXTS = new Set(['xlsx', 'xls', 'csv'])
const DOC_EXTS = new Set(['docx', 'pdf', 'txt'])

function extOf(name: string) {
  const parts = String(name || '').toLowerCase().split('.')
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

// POST /api/admin/comprehensive-exams/[id]/questions/import
// رفع ملف أسئلة: Excel (موثوق) أو مستند Word/PDF/TXT (مسودة للمراجعة).
// كل سؤال مستورد يبدأ بانتظار المراجعة؛ الصفوف الفاشلة تُجمع ولا توقف
// الملف. ?dryRun=true (أو حقل dryRun) يعاين فقط دون حفظ.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true, status: true, title: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const form = await req.formData()
    const file = form.get('file') as unknown as File | null
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'ارفع ملف أسئلة (Excel أو Word أو PDF أو نص)' }, { status: 400 })
    }
    const blob = file
    const fileName = blob.name || 'questions'
    const ext = extOf(fileName)
    if (!EXCEL_EXTS.has(ext) && !DOC_EXTS.has(ext)) {
      return NextResponse.json({ error: 'صيغة غير مدعومة — المسموح: xlsx/xls/csv أو docx/pdf/txt' }, { status: 400 })
    }
    const buffer = Buffer.from(await blob.arrayBuffer())
    if (buffer.length > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'حجم الملف يتجاوز 10 ميغابايت' }, { status: 400 })
    }
    const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true' || form.get('dryRun') === 'true'
    let parsed: { questions: any[]; errors: Array<{ row: number; message: string }>; skipped?: number }
    let source: 'EXCEL_IMPORT' | 'DOC_IMPORT'
    if (EXCEL_EXTS.has(ext)) {
      source = 'EXCEL_IMPORT'
      parsed = parseComprehensiveExamExcel(buffer)
    } else {
      source = 'DOC_IMPORT'
      const extracted = await extractDocumentText(buffer, blob.type || '', fileName, 40000)
      if (!extracted.readable) {
        return NextResponse.json({ error: `تعذر استخراج نص مقروء من المستند: ${extracted.note}` }, { status: 422 })
      }
      parsed = parseComprehensiveExamDocText(extracted.text)
    }
    if (!parsed.questions.length) {
      return NextResponse.json(
        { error: 'لم أجد أي سؤال صالح في الملف', errors: parsed.errors, skipped: parsed.skipped ?? 0 },
        { status: 422 },
      )
    }
    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        source,
        valid: parsed.questions.length,
        errors: parsed.errors,
        skipped: parsed.skipped ?? 0,
        maxRows: COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS,
      })
    }
    const last = await db.comprehensiveExamQuestion.findFirst({
      where: { examId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    let order = last?.order ?? 0
    await db.comprehensiveExamQuestion.createMany({
      data: parsed.questions.map((q: any) => ({
        examId: id,
        order: ++order,
        type: q.type,
        text: q.text,
        options: JSON.stringify(q.options),
        correctAnswer: q.correctAnswer,
        source,
        sourceEvidence: q.sourceEvidence,
        status: 'PENDING_REVIEW',
        createdById: admin.id,
      })),
    })
    await audit(
      { id: admin.id, name: admin.name },
      'IMPORT_COMPREHENSIVE_EXAM_QUESTIONS',
      'ComprehensiveExam',
      id,
      `استيراد ${parsed.questions.length} سؤالاً من ملف ${fileName} (${source === 'EXCEL_IMPORT' ? 'Excel' : 'مستند'}) إلى الامتحان الشامل «${exam.title}» — كلها بانتظار المراجعة؛ ${parsed.errors.length} صفاً مرفوضاً`,
    )
    return NextResponse.json({
      ok: true,
      source,
      imported: parsed.questions.length,
      errors: parsed.errors,
      skipped: parsed.skipped ?? 0,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam import error:', e)
    return NextResponse.json({ error: 'تعذر استيراد الأسئلة من الملف' }, { status: 500 })
  }
}
