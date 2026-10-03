import { getWhatsAppCloudConfig } from '@/lib/whatsapp-cloud'

export type WhatsAppMediaInfo = {
  id: string
  url: string
  mimeType: string
  fileSize: number
  sha256?: string | null
}

export async function getOfficialWhatsAppMediaInfo(mediaId: string, phoneNumberId?: string | null): Promise<WhatsAppMediaInfo> {
  const id = String(mediaId || '').trim()
  if (!id) throw new Error('WhatsApp media id is required.')
  const config = getWhatsAppCloudConfig(phoneNumberId || undefined)
  if (!config) throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.error?.message || data?.error?.code || `WhatsApp media lookup failed with status ${response.status}`
    throw new Error(String(message).slice(0, 500))
  }

  const url = String(data?.url || '').trim()
  if (!url) throw new Error('WhatsApp media URL was not returned.')
  return {
    id,
    url,
    mimeType: String(data?.mime_type || '').trim(),
    fileSize: Number(data?.file_size || 0),
    sha256: data?.sha256 ? String(data.sha256) : null,
  }
}

export async function downloadOfficialWhatsAppMediaBase64(info: WhatsAppMediaInfo, phoneNumberId?: string | null) {
  const config = getWhatsAppCloudConfig(phoneNumberId || undefined)
  if (!config) throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  const response = await fetch(info.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`WhatsApp media download failed with status ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  return buffer.toString('base64')
}
