import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readStoredFile } from '@/lib/storage'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const template = await db.certificateTemplate.findFirst({
    where: { id, active: true },
    select: { storageProvider: true, storageKey: true, fileUrl: true, mimeType: true, fileName: true },
  })
  if (!template) return NextResponse.json({ error: 'قالب الشهادة غير متاح' }, { status: 404 })
  const stored = await readStoredFile({ provider: template.storageProvider, key: template.storageKey, url: template.fileUrl, mimeType: template.mimeType })
  if (!stored) return NextResponse.json({ error: 'تعذر تحميل قالب الشهادة' }, { status: 404 })
  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': stored.mimeType || template.mimeType || 'image/png',
      'Content-Length': String(stored.buffer.byteLength),
      'Cache-Control': 'private, max-age=300',
    },
  })
}
