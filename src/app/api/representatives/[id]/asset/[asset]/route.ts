import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type AssetKind = 'profilePhoto' | 'officialCard'

function assetFields(rep: any, asset: AssetKind) {
  if (asset === 'profilePhoto') {
    return {
      provider: rep.profilePhotoStorageProvider,
      key: rep.profilePhotoStorageKey,
      url: rep.profilePhotoUrl,
      mimeType: rep.profilePhotoMime || 'image/jpeg',
    }
  }
  return {
    provider: rep.officialCardStorageProvider,
    key: rep.officialCardStorageKey,
    url: rep.officialCardUrl,
    mimeType: rep.officialCardMime || 'application/pdf',
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; asset: string }> }) {
  const { id, asset } = await params
  if (!['profilePhoto', 'officialCard'].includes(asset)) {
    return NextResponse.json({ error: 'INVALID_ASSET' }, { status: 400 })
  }

  const rep = await db.academyRepresentative.findFirst({
    where: { id, deletedAt: null, status: 'ACTIVE' },
  })
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const fields = assetFields(rep, asset as AssetKind)
  if (!fields.key && !fields.url) return NextResponse.json({ error: 'NO_FILE' }, { status: 404 })

  const stored = await readStoredFile(fields)
  if (!stored) return NextResponse.json({ error: 'FILE_UNREADABLE' }, { status: 404 })

  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': stored.mimeType || fields.mimeType,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  })
}
