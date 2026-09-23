import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function contentDisposition(fileName?: string | null): string {
  const safe = String(fileName || 'deliverable').replace(/[\r\n"\\]/g, '_').slice(0, 180)
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const deliverable = await db.serviceDeliverable.findFirst({
      where: {
        id,
        status: 'PUBLISHED',
        visibleToStudent: true,
        admission: {
          is: { OR: [{ userId: user.id }, { email: user.email }] },
        },
      },
      include: { admission: { select: { reference: true, status: true, payments: { select: { status: true } } } } },
    })
    if (!deliverable) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    const eligible = ['RESULT_APPROVED', 'CERTIFIED'].includes(deliverable.admission.status) && deliverable.admission.payments.length > 0 && deliverable.admission.payments.every((p) => p.status === 'PAID')
    if (!eligible) return NextResponse.json({ error: 'PAYMENT_REQUIRED', message: 'هذا المخرج لا يصبح متاحاً إلا بعد اعتماد الطلب وسداد الفواتير المستحقة.' }, { status: 403 })

    if (deliverable.externalUrl && /^https?:\/\//i.test(deliverable.externalUrl)) {
      return NextResponse.redirect(deliverable.externalUrl)
    }
    if (deliverable.verificationUrl && !deliverable.storageKey && !deliverable.fileUrl) {
      return NextResponse.redirect(deliverable.verificationUrl)
    }

    const stored = await readStoredFile({
      provider: deliverable.storageProvider,
      key: deliverable.storageKey,
      url: deliverable.fileUrl,
      mimeType: deliverable.mimeType || 'application/octet-stream',
    })
    if (!stored) return NextResponse.json({ error: 'FILE_NOT_AVAILABLE' }, { status: 404 })

    return new Response(new Uint8Array(stored.buffer), {
      headers: {
        'content-type': stored.mimeType || 'application/octet-stream',
        'content-length': String(stored.buffer.byteLength),
        'content-disposition': contentDisposition(deliverable.fileName || deliverable.title),
        'cache-control': 'private, no-store',
      },
    })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json({ error: 'SERVER_ERROR', message: msg.slice(0, 200) }, { status: 500 })
  }
}
