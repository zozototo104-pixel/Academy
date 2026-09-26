import { getPublicStorageUrlForKey, storeFileBufferAtKey, type StoredFileResult } from '@/lib/storage'

export const HOME_IMAGE_ASSETS = {
  about1: {
    id: 'about1',
    key: 'site-assets/home/about1.jpg',
    fileName: 'about1.jpg',
    mimeType: 'image/jpeg',
    legacyUrl: 'https://amarican-academy.vercel.app/about1.jpg',
  },
  about2: {
    id: 'about2',
    key: 'site-assets/home/about2.jpg',
    fileName: 'about2.jpg',
    mimeType: 'image/jpeg',
    legacyUrl: 'https://amarican-academy.vercel.app/about2.jpg',
  },
} as const

export type HomeImageAssetId = keyof typeof HOME_IMAGE_ASSETS
export type HomeImageAsset = (typeof HOME_IMAGE_ASSETS)[HomeImageAssetId]

const MAX_HOME_IMAGE_BYTES = 8 * 1024 * 1024

export function getHomeImageAsset(id: string): HomeImageAsset | null {
  return HOME_IMAGE_ASSETS[id as HomeImageAssetId] || null
}

export function getHomeImagePublicUrl(id: HomeImageAssetId): string | null {
  return getPublicStorageUrlForKey(HOME_IMAGE_ASSETS[id].key)
}

async function fetchLegacyHomeImage(asset: HomeImageAsset): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(asset.legacyUrl, {
    cache: 'no-store',
    headers: { 'User-Agent': 'AACT-Academy-Asset-Migration/1.0' },
  })

  if (!response.ok) {
    throw new Error(`LEGACY_ASSET_FETCH_FAILED:${response.status}:${asset.id}`)
  }

  const mimeType = (response.headers.get('content-type') || asset.mimeType).split(';')[0].trim() || asset.mimeType
  if (!mimeType.startsWith('image/')) {
    throw new Error(`LEGACY_ASSET_NOT_IMAGE:${mimeType}:${asset.id}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error(`LEGACY_ASSET_EMPTY:${asset.id}`)
  if (buffer.byteLength > MAX_HOME_IMAGE_BYTES) throw new Error(`LEGACY_ASSET_TOO_LARGE:${asset.id}`)

  return { buffer, mimeType }
}

export async function uploadHomeImageAsset(asset: HomeImageAsset): Promise<StoredFileResult> {
  const source = await fetchLegacyHomeImage(asset)
  return storeFileBufferAtKey({
    buffer: source.buffer,
    fileName: asset.fileName,
    mimeType: source.mimeType,
    key: asset.key,
  })
}

export async function uploadHomeImageAssets() {
  const results: Array<{
    id: HomeImageAssetId
    key: string
    ok: boolean
    url: string | null
    size?: number
    mimeType?: string
    error?: string
  }> = []

  for (const id of Object.keys(HOME_IMAGE_ASSETS) as HomeImageAssetId[]) {
    const asset = HOME_IMAGE_ASSETS[id]
    try {
      const stored = await uploadHomeImageAsset(asset)
      results.push({ id, key: asset.key, ok: true, url: stored.url, size: stored.size, mimeType: stored.mimeType })
    } catch (error: any) {
      results.push({ id, key: asset.key, ok: false, url: getPublicStorageUrlForKey(asset.key), error: String(error?.message || error) })
    }
  }

  return results
}

export async function checkHomeImageAsset(asset: HomeImageAsset) {
  const url = getPublicStorageUrlForKey(asset.key)
  if (!url) {
    return { id: asset.id, key: asset.key, configured: false, exists: false, url: null, status: null as number | null }
  }

  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    return { id: asset.id, key: asset.key, configured: true, exists: response.ok, url, status: response.status }
  } catch (error: any) {
    return { id: asset.id, key: asset.key, configured: true, exists: false, url, status: null, error: String(error?.message || error) }
  }
}
