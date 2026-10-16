import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { refundExpiredGeminiLiveSessions } from '@/lib/live-usage-guard'

async function retentionDays() {
  const raw = await getSetting('CHAT_RETENTION_DAYS').catch(() => process.env.CHAT_RETENTION_DAYS || '180')
  const n = Number(raw || 180)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180
}

export async function cleanupOldAiConversations(now = new Date()) {
  const days = await retentionDays()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const preservedKinds = ['DEFENSE', 'THESIS_DEFENSE', 'EXAM', 'APPEAL', 'THESIS_REVIEW']
  const chat = await db.chatMessage.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ kind: null }, { kind: { notIn: preservedKinds } }],
    },
  })
  const whatsapp = await db.whatsAppConversationMessage.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      NOT: [
        { rawType: { in: ['DEFENSE', 'EXAM', 'APPEAL'] } },
        { sender: 'SYSTEM', text: { contains: 'مناقشة' } },
      ],
    },
  })
  const live = await refundExpiredGeminiLiveSessions(now).catch(() => ({ sessions: 0, refunded: 0 }))
  return { cutoff, days, chatDeleted: chat.count, whatsappDeleted: whatsapp.count, live }
}
