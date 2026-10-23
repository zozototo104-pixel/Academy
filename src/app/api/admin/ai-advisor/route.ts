import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { dismissAdvisorAdvice, generateAdvisorAdvice, listAdvisorAdvice } from '@/lib/ai-advisor-advice'

export async function GET() {
  try {
    await requireAdmin()
    return NextResponse.json({ advice: await listAdvisorAdvice('OPEN') })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل توصيات المستشار' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const actor = await requireAdmin()
    const result = await generateAdvisorAdvice(actor.id)
    return NextResponse.json(result)
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر توليد توصيات المستشار' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireAdmin()
    const body = await req.json().catch(() => null)
    const id = (body as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id.trim()) {
      return NextResponse.json({ error: 'معرّف التوصية مطلوب' }, { status: 400 })
    }
    const advice = await dismissAdvisorAdvice(id.trim(), actor.id)
    return NextResponse.json({ advice })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    if (error?.code === 'P2025') return NextResponse.json({ error: 'التوصية غير موجودة' }, { status: 404 })
    return NextResponse.json({ error: 'تعذر إغلاق توصية المستشار' }, { status: 500 })
  }
}
