import { createHash } from 'crypto'

export function whatsappHashSecret() {
  return process.env.WHATSAPP_HASH_SECRET || process.env.NEXTAUTH_SECRET || 'aact-whatsapp-local-hash'
}

export function whatsappWaIdHash(from: string) {
  return createHash('sha256').update(`${whatsappHashSecret()}:${String(from || '')}`).digest('hex')
}

export function maskWhatsAppPhone(value?: string | null) {
  const raw = String(value || '').replace(/\D/g, '')
  if (!raw) return ''
  return raw.length <= 4 ? `****${raw}` : `${raw.slice(0, 3)}****${raw.slice(-4)}`
}
