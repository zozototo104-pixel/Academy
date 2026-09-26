import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { checkHomeImageAsset, HOME_IMAGE_ASSETS, uploadHomeImageAssets, type HomeImageAssetId } from '@/lib/site-assets'
import { storageErrorMessage } from '@/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET() {
  try {
    await requireAdmin()
    const assets = await Promise.all(
      (Object.keys(HOME_IMAGE_ASSETS) as HomeImageAssetId[]).map((id) => checkHomeImageAsset(HOME_IMAGE_ASSETS[id]))
    )

    return NextResponse.json({
      ok: true,
      configured: assets.some((asset) => asset.configured),
      assets,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر فحص صور الصفحة الرئيسية' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const admin = await requireAdmin()
    const assets = await uploadHomeImageAssets()
    const ok = assets.every((asset) => asset.ok)

    await audit(
      { id: admin.id, name: admin.name },
      'UPLOAD_HOME_IMAGES',
      'SiteAsset',
      'home-images',
      `رفع صور الصفحة الرئيسية إلى التخزين الخارجي: ${assets.filter((asset) => asset.ok).length}/${assets.length}`
    )

    return NextResponse.json({ ok, assets }, { status: ok ? 200 : 502 })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    const raw = String(error?.message || error || '')
    if (raw.includes('FILE_STORAGE') || raw.includes('S3_UPLOAD') || raw.includes('EMPTY_FILE')) {
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
    }
    return NextResponse.json({ error: 'تعذر رفع صور الصفحة الرئيسية إلى التخزين الخارجي' }, { status: 500 })
  }
}
