import { describe, expect, test } from 'bun:test'
import { extractWhatsAppInboundMessages } from '../src/lib/whatsapp-cloud'

describe('WhatsApp incoming attachments', () => {
  function payload(type: string, media: Record<string, unknown>) {
    return {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123456789' },
        contacts: [{ wa_id: '970599123456', profile: { name: 'Test contact' } }],
        messages: [{ id: 'wamid.test', from: '970599123456', type, [type]: media }],
      } }] }],
    }
  }

  test.each(['image', 'video', 'audio', 'document', 'sticker'])(
    'extracts %s media identifier and MIME type',
    (type) => {
      const messages = extractWhatsAppInboundMessages(payload(type, {
        id: '1234567891011', mime_type: type === 'document' ? 'application/pdf' : 'image/jpeg',
        sha256: 'checksum', caption: 'وصف الصورة', filename: 'document.pdf', voice: true,
      }))
      expect(messages).toHaveLength(1)
      expect(messages[0].rawType).toBe(type)
      expect(messages[0].mediaId).toBe('1234567891011')
      expect(messages[0].mediaSha256).toBe('checksum')
      expect(messages[0].mediaCaption).toBe('وصف الصورة')
      expect(messages[0].mediaFilename).toBe('document.pdf')
      expect(messages[0].isVoice).toBe(type === 'audio')
    },
  )

  test('preserves ordinary text message semantics', () => {
    const result = extractWhatsAppInboundMessages(payload('text', { body: 'مرحبا' }))
    expect(result[0].text).toBe('مرحبا')
    expect(result[0].mediaId).toBeUndefined()
  })

  test('does not invent an attachment ID for a Meta unsupported message', () => {
    const result = extractWhatsAppInboundMessages(payload('unsupported', { id: 'not-a-media-id' }))
    expect(result[0].rawType).toBe('unsupported')
    expect(result[0].mediaId).toBeUndefined()
  })
})
