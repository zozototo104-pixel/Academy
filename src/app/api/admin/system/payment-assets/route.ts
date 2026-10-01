import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function upsertSetting(key: string, value: string) {
  return db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const form = await req.formData()
    const asset = String(form.get('asset') || 'BINANCE_PAY_QR')
    const file = form.get('file')

    if (asset !== 'BINANCE_PAY_QR') {
      return NextResponse.json({ error: 'نوع الأصل غير مدعوم.' }, { status: 400 })
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'يرجى اختيار صورة QR أولاً.' }, { status: 400 })
    }

    const mimeType = file.type || 'application/octet-stream'
    if (!mimeType.startsWith('image/')) {
      return NextResponse.json({ error: 'ملف QR يجب أن يكون صورة.' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!buffer.byteLength) {
      return NextResponse.json({ error: 'الصورة فارغة.' }, { status: 400 })
    }

    const stored = await storeFileBuffer({
      buffer,
      fileName: file.name || 'binance-pay-qr.png',
      mimeType,
      namespace: 'payments/binance-pay',
    })

    await upsertSetting('USDT_BINANCE_PAY_QR_IMAGE_URL', stored.url)
    await upsertSetting('USDT_NETWORK', 'BINANCE_PAY')

    await db.auditLog.create({
      data: {
        actorId: admin.id,
        actorName: admin.name || admin.email || 'إدارة النظام',
        action: 'UPLOAD_BINANCE_PAY_QR',
        entity: 'Setting',
        entityId: 'USDT_BINANCE_PAY_QR_IMAGE_URL',
        details: `${stored.provider}:${stored.key}`,
      },
    }).catch(() => {})

    return NextResponse.json({
      ok: true,
      settingKey: 'USDT_BINANCE_PAY_QR_IMAGE_URL',
      url: stored.url,
      storage: {
        provider: stored.provider,
        key: stored.key,
        size: stored.size,
        mimeType: stored.mimeType,
      },
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
  }
}
