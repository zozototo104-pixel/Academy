import { NextRequest, NextResponse } from 'next/server'
import { getHomeImageAsset, uploadHomeImageAsset } from '@/lib/site-assets'
import { getPublicStorageUrlForKey } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cachedRedirect(url: string, seconds: number) {
  const response = NextResponse.redirect(url, { status: 307 })
  response.headers.set('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=604800`)
  return response
}

export async function GET(_req: NextRequest, context: { params: Promise<{ image: string }> }) {
  const params = await context.params
  const asset = getHomeImageAsset(params.image)
  if (!asset) return NextResponse.json({ error: 'الصورة غير موجودة' }, { status: 404 })

  const publicUrl = getPublicStorageUrlForKey(asset.key)
  if (publicUrl) {
    try {
      const existing = await fetch(publicUrl, { method: 'HEAD', cache: 'no-store' })
      if (existing.ok) return cachedRedirect(publicUrl, 24 * 60 * 60)
    } catch {}

    try {
      const stored = await uploadHomeImageAsset(asset)
      return cachedRedirect(stored.url, 24 * 60 * 60)
    } catch (error) {
      console.error('home image storage self-heal failed:', asset.id, error)
    }
  }

  return cachedRedirect(asset.legacyUrl, 5 * 60)
}
