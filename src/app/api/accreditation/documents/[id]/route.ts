import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readStoredFile } from '@/lib/storage'

function safeDownloadName(value: string) {
  return String(value || 'document')
    .replace(/[\r\n"\\/]+/g, '-')
    .slice(0, 140) || 'document'
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const doc = await db.accreditationDocument.findFirst({
    where: {
      id,
      active: true,
      OR: [
        { partnershipId: null },
        { partnership: { active: true } },
      ],
    },
    select: {
      title: true,
      fileName: true,
      mimeType: true,
      storageProvider: true,
      storageKey: true,
      fileUrl: true,
    },
  })
  if (!doc) return NextResponse.json({ error: 'الوثيقة غير متاحة' }, { status: 404 })

  const stored = await readStoredFile({
    provider: doc.storageProvider,
    key: doc.storageKey,
    url: doc.fileUrl,
    mimeType: doc.mimeType,
  })
  if (!stored) return NextResponse.json({ error: 'تعذر تحميل الوثيقة' }, { status: 404 })

  const download = req.nextUrl.searchParams.get('download') === '1'
  const fileName = safeDownloadName(doc.fileName || doc.title)
  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': stored.mimeType || doc.mimeType || 'application/octet-stream',
      'Content-Length': String(stored.buffer.byteLength),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName}"`,
      'Cache-Control': 'private, max-age=60',
    },
  })
}
