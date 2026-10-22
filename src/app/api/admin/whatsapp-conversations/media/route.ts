import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { getWhatsAppCloudConfig } from '@/lib/whatsapp-cloud'
import { getOfficialWhatsAppMediaInfo } from '@/lib/whatsapp-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const MEDIA_TYPES = new Set(['audio', 'image', 'video', 'document', 'sticker'])

function isMetaMediaUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['fbcdn.net', 'fbsbx.com', 'whatsapp.net'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch { return false }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const messageId = new URL(req.url).searchParams.get('messageId') || ''
    if (!messageId || messageId.length > 128) return NextResponse.json({ error: 'Invalid message ID' }, { status: 400 })

    const message = await db.whatsAppConversationMessage.findUnique({
      where: { id: messageId },
      select: { direction: true, rawType: true, meta: true, conversation: { select: { phoneNumberId: true } } },
    })
    if (!message || message.direction !== 'INBOUND' || !MEDIA_TYPES.has(message.rawType || '')) {
      return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
    }
    const meta = message.meta && typeof message.meta === 'object' && !Array.isArray(message.meta)
      ? message.meta as Record<string, unknown> : {}
    const mediaId = typeof meta.mediaId === 'string' ? meta.mediaId : ''
    if (!mediaId || !/^\d{1,40}$/.test(mediaId)) {
      return NextResponse.json({ error: 'Attachment not available for this message' }, { status: 404 })
    }

    const phoneNumberId = message.conversation.phoneNumberId || undefined
    const info = await getOfficialWhatsAppMediaInfo(mediaId, phoneNumberId)
    if (!isMetaMediaUrl(info.url)) return NextResponse.json({ error: 'Invalid media source' }, { status: 502 })
    if (info.fileSize > MAX_MEDIA_BYTES) return NextResponse.json({ error: 'Attachment exceeds preview size limit' }, { status: 413 })
    const config = getWhatsAppCloudConfig(phoneNumberId)
    if (!config) return NextResponse.json({ error: 'WhatsApp media service unavailable' }, { status: 503 })
    const response = await fetch(info.url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      redirect: 'error',
      cache: 'no-store',
    })
    if (!response.ok) return NextResponse.json({ error: 'Attachment download unavailable' }, { status: 502 })
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_MEDIA_BYTES) {
      await response.body?.cancel()
      return NextResponse.json({ error: 'Attachment exceeds preview size limit' }, { status: 413 })
    }
    const reader = response.body?.getReader()
    if (!reader) return NextResponse.json({ error: 'Empty attachment' }, { status: 502 })
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel()
        return NextResponse.json({ error: 'Attachment exceeds preview size limit' }, { status: 413 })
      }
      chunks.push(value)
    }
    const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
    const sourceType = info.mimeType.toLowerCase()
    const allowedType = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|webm)|application\/pdf|text\/plain)$/.test(sourceType)
    const contentType = allowedType ? sourceType : 'application/octet-stream'
    return new NextResponse(content, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(content.length),
        'Content-Disposition': contentType === 'application/octet-stream' ? 'attachment' : 'inline',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'Attachment is currently unavailable' }, { status: 502 })
  }
}
