import { NextRequest, NextResponse } from 'next/server'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function cleanKey(value: string) {
  return String(value || '')
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export async function GET(req: NextRequest) {
  const key = cleanKey(req.nextUrl.searchParams.get('key') || '')
  if (!key || !key.startsWith('payments/binance-pay/')) {
    return new NextResponse('Not found', { status: 404 })
  }
  if (key.split('/').some((part) => !part || part === '.' || part === '..')) {
    return new NextResponse('Not found', { status: 404 })
  }

  const stored = await readStoredFile({ provider: 's3', key, mimeType: 'image/png' })
  if (!stored?.buffer) return new NextResponse('Not found', { status: 404 })

  const mimeType = stored.mimeType.startsWith('image/') ? stored.mimeType : 'image/png'
  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
