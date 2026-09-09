import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { suggestBooksForProgram } from '@/lib/books-ai'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/admin/books/suggest — اقتراح كتب من خبير الذكاء الاصطناعي حسب التخصص
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const { programId } = await req.json()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({
      where: { id: programId },
      select: { titleAr: true, titleEn: true, category: true, description: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const suggestions = await suggestBooksForProgram(program)
    return NextResponse.json({ suggestions })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('books suggest error:', e)
    return NextResponse.json({ error: 'تعذر توليد اقتراحات الكتب — حاول مرة أخرى' }, { status: 500 })
  }
}
