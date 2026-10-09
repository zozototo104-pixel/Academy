import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getThesisDigest, summarizeDigestForPrompt } from '@/lib/thesis-context'

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const thesisId = String(req.nextUrl.searchParams.get('thesisId') || '').trim()
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })
    const thesis = await db.thesisSubmission.findFirst({ where: { id: thesisId, userId: user.id }, select: { id: true, status: true, title: true, extractionStatus: true } })
    if (!thesis) return NextResponse.json({ error: 'البحث غير موجود' }, { status: 404 })
    if (thesis.status !== 'SCHEDULED') return NextResponse.json({ error: 'المناقشة غير مجدولة' }, { status: 409 })
    if (thesis.extractionStatus !== 'READY') return NextResponse.json({ error: 'يجب رفع البحث ومعالجته قبل المناقشة' }, { status: 409 })
    const digest = await getThesisDigest(thesis.id)
    return NextResponse.json({ context: `عنوان البحث: ${thesis.title}\nDigest:\n${summarizeDigestForPrompt(digest, 6000)}` })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('defense context error:', error)
    return NextResponse.json({ error: 'تعذر تحميل سياق المناقشة' }, { status: 500 })
  }
}
