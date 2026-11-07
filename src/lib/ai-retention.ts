import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { refundExpiredGeminiLiveSessions } from '@/lib/live-usage-guard'

async function retentionDays() {
  const raw = await getSetting('CHAT_RETENTION_DAYS').catch(() => process.env.CHAT_RETENTION_DAYS || '180')
  const n = Number(raw || 180)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180
}

// الحذف على دفعات بصفحات معرّفات (500) بدل deleteMany واحدة عملاقة: أول
// تشغيلة بعد انقطاع طويل كانت ستحذف كل شيء بعبارة واحدة بلا حد. الحلقة
// تتوقف عند صفحة قصيرة، والمجموع النهائي هو نفسه عدد الصفوف المحذوفة.
const RETENTION_DELETE_BATCH = 500

async function deleteInBatches(model: any, where: Record<string, unknown>): Promise<number> {
  let total = 0
  for (;;) {
    const page = await model.findMany({ where, select: { id: true }, take: RETENTION_DELETE_BATCH })
    if (!page.length) break
    const res = await model.deleteMany({ where: { id: { in: page.map((row: any) => row.id) } } })
    total += res.count
    if (page.length < RETENTION_DELETE_BATCH) break
  }
  return total
}

export async function cleanupOldAiConversations(now = new Date()) {
  const days = await retentionDays()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const preservedKinds = ['DEFENSE', 'THESIS_DEFENSE', 'EXAM', 'APPEAL', 'THESIS_REVIEW']
  const chatDeleted = await deleteInBatches(db.chatMessage, {
    createdAt: { lt: cutoff },
    OR: [{ kind: null }, { kind: { notIn: preservedKinds } }],
  })
  // الحفظ في واتساب يوازي حفظ الدردشة: نفس أنواع المحادثات المحفوظة
  // (THESIS_DEFENSE وTHESIS_REVIEW كانتا محفوظتين للدردشة ومحذوفتين هنا)،
  // إضافة إلى رسائل النظام الخاصة بالمناقشات.
  const whatsappDeleted = await deleteInBatches(db.whatsAppConversationMessage, {
    createdAt: { lt: cutoff },
    NOT: [
      { rawType: { in: preservedKinds } },
      { sender: 'SYSTEM', text: { contains: 'مناقشة' } },
    ],
  })
  const live = await refundExpiredGeminiLiveSessions(now).catch(() => ({ sessions: 0, refunded: 0 }))
  return { cutoff, days, chatDeleted, whatsappDeleted, live }
}
