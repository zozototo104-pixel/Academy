import { NextResponse } from 'next/server'
import { representativeLookupCandidates } from '@/lib/academy-representatives'
import { db } from '@/lib/db'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function safeFileName(value?: string | null) {
  return String(value || 'representative-file')
    .trim()
    .replace(/[\r\n"\\/]+/g, '-')
    .slice(0, 160) || 'representative-file'
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await params
  const candidates = representativeLookupCandidates(slug)
  const representative = await db.academyRepresentative.findFirst({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      OR: [{ slug: { in: candidates } }, { id: { in: candidates } }],
    },
    select: {
      id: true,
      files: {
        where: { id: fileId },
        take: 1,
        select: {
          id: true,
          title: true,
          fileName: true,
          mimeType: true,
          storageProvider: true,
          storageKey: true,
          fileUrl: true,
        },
      },
    },
  })

  const file = representative?.files?.[0]
  if (!file) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (!file.storageKey && !file.fileUrl) return NextResponse.json({ error: 'NO_FILE' }, { status: 404 })

  const stored = await readStoredFile({
    provider: file.storageProvider,
    key: file.storageKey,
    url: file.fileUrl,
    mimeType: file.mimeType || 'application/octet-stream',
  })
  if (!stored) return NextResponse.json({ error: 'FILE_UNREADABLE' }, { status: 404 })

  const mimeType = stored.mimeType || file.mimeType || 'application/octet-stream'
  const disposition = /^image\//i.test(mimeType) || mimeType === 'application/pdf' ? 'inline' : 'attachment'
  const fileName = safeFileName(file.fileName || file.title)

  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
