import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function fileSafe(value: unknown) {
  return String(value || 'payment-proof')
    .trim()
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .slice(0, 140) || 'payment-proof'
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdmin()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرّف الإثبات مطلوب' }, { status: 400 })

    const proof = await db.paymentProof.findUnique({
      where: { id },
      include: { payment: { select: { id: true, invoiceNo: true } } },
    })
    if (!proof) return NextResponse.json({ error: 'إثبات الدفع غير موجود' }, { status: 404 })

    const stored = await readStoredFile({
      provider: proof.storageProvider,
      key: proof.storageKey,
      url: proof.storageUrl,
      mimeType: proof.mimeType,
    })
    if (!stored) return NextResponse.json({ error: 'تعذر قراءة ملف إثبات الدفع من التخزين' }, { status: 404 })

    const body = new ArrayBuffer(stored.buffer.byteLength)
    new Uint8Array(body).set(stored.buffer)
    const filename = fileSafe(`${proof.payment.invoiceNo}-${proof.fileName}`)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': stored.mimeType || proof.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Length': String(stored.buffer.byteLength),
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin payment proof download error:', e)
    return NextResponse.json({ error: 'تعذر تحميل إثبات الدفع' }, { status: 500 })
  }
}
