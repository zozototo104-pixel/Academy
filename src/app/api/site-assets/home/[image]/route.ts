import { NextRequest, NextResponse } from 'next/server'
import { getHomeImageAsset, uploadHomeImageAsset } from '@/lib/site-assets'
import { getPublicStorageUrlForKey, readStoredFile, type StoredFileResult } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cachedRedirect(url: string, seconds: number, source: string) {
  const response = NextResponse.redirect(url, { status: 307 })
  response.headers.set('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=604800`)
  response.headers.set('X-AACT-Asset-Source', source)
  return response
}

function imageResponse(buffer: Buffer, mimeType: string, source: string) {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': mimeType || 'image/jpeg',
      'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      'X-AACT-Asset-Source': source,
    },
  })
}

async function serveStoredAsset(stored: StoredFileResult, fallbackMimeType: string) {
  if (stored.provider === 'local') return cachedRedirect(stored.url, 24 * 60 * 60, 'local')

  if (stored.provider === 's3') {
    const publicUrl = getPublicStorageUrlForKey(stored.key)
    if (publicUrl) return cachedRedirect(publicUrl, 24 * 60 * 60, 'r2-public')

    const file = await readStoredFile({ provider: 's3', key: stored.key, mimeType: stored.mimeType || fallbackMimeType })
    if (file) return imageResponse(file.buffer, file.mimeType, 'r2-proxy')
  }

  return null
}

export async function GET(_req: NextRequest, context: { params: Promise<{ image: string }> }) {
  const params = await context.params
  const asset = getHomeImageAsset(params.image)
  if (!asset) return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 })

  const publicUrl = getPublicStorageUrlForKey(asset.key)
  if (publicUrl) {
    try {
      const existing = await fetch(publicUrl, { method: 'HEAD', cache: 'no-store' })
      if (existing.ok) return cachedRedirect(publicUrl, 24 * 60 * 60, 'r2-public')
    } catch {}
  }

  try {
    const stored = await uploadHomeImageAsset(asset)
    const served = await serveStoredAsset(stored, asset.mimeType)
    if (served) return served
  } catch (error) {
    console.error('home image storage self-heal failed:', asset.id, error)
  }

  if (publicUrl) {
    return NextResponse.json({ error: 'تعذر رفع أو قراءة صورة الواجهة من التخزين الخارجي.' }, { status: 502 })
  }

  return cachedRedirect(asset.legacyUrl, 5 * 60, 'legacy-fallback')
}
