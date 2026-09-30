import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { sendOfficialWhatsAppText } from '@/lib/whatsapp-cloud'
import { recordWhatsAppOutboundMessage, setWhatsAppConversationStatus } from '@/lib/whatsapp-conversations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function jsonError(error: any, status = 500) {
  return NextResponse.json({ ok: false, error: String(error?.message || error || 'تعذر تنفيذ العملية') }, { status })
}

function normalizeStatus(status: string | null) {
  const allowed = ['BOT_ACTIVE', 'HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'CLOSED']
  return allowed.includes(String(status || '')) ? String(status) : null
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const url = new URL(req.url)
    const id = url.searchParams.get('id') || ''
    if (id) {
      const conversation = await db.whatsAppConversation.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { createdAt: 'asc' }, take: 200 },
        },
      })
      if (!conversation) return NextResponse.json({ ok: false, error: 'المحادثة غير موجودة' }, { status: 404 })
      return NextResponse.json({ conversation })
    }

    const status = normalizeStatus(url.searchParams.get('status'))
    const search = String(url.searchParams.get('search') || '').trim()
    const where: any = {}
    if (status) where.status = status
    if (search) {
      where.OR = [
        { phoneMasked: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { lastMessageText: { contains: search, mode: 'insensitive' } },
      ]
    }
    const conversations = await db.whatsAppConversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: 80,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    const counts = await db.whatsAppConversation.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => [])
    return NextResponse.json({ conversations, counts })
  } catch (error: any) {
    return jsonError(error, String(error?.message) === 'UNAUTHORIZED' ? 401 : 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = String(body?.id || '')
    const action = String(body?.action || '')
    if (!id) return NextResponse.json({ ok: false, error: 'conversation id required' }, { status: 400 })

    const conversation = await db.whatsAppConversation.findUnique({ where: { id } })
    if (!conversation) return NextResponse.json({ ok: false, error: 'المحادثة غير موجودة' }, { status: 404 })

    if (action === 'claim') {
      const updated = await setWhatsAppConversationStatus({ conversationId: id, status: 'HUMAN_ACTIVE', adminId: admin.id, adminName: admin.name })
      if (conversation.handoffRequestId) {
        await db.humanHandoffRequest.updateMany({
          where: { id: conversation.handoffRequestId },
          data: { status: 'IN_PROGRESS', assignedToId: admin.id, assignedAt: new Date() },
        }).catch(() => {})
      }
      await db.auditLog.create({ data: { actorId: admin.id, actorName: admin.name, action: 'WHATSAPP_CONVERSATION_CLAIMED', entity: 'WhatsAppConversation', entityId: id, details: conversation.phoneMasked } }).catch(() => {})
      return NextResponse.json({ ok: true, conversation: updated })
    }

    if (action === 'release' || action === 'close') {
      const nextStatus = action === 'close' ? 'CLOSED' : 'BOT_ACTIVE'
      const updated = await setWhatsAppConversationStatus({ conversationId: id, status: nextStatus, adminId: admin.id, adminName: admin.name })
      if (conversation.handoffRequestId) {
        await db.humanHandoffRequest.updateMany({
          where: { id: conversation.handoffRequestId },
          data: action === 'close'
            ? { status: 'CLOSED', closedAt: new Date(), assignedToId: admin.id }
            : { status: 'CONTACTED', contactedAt: new Date(), assignedToId: admin.id },
        }).catch(() => {})
      }
      await db.auditLog.create({ data: { actorId: admin.id, actorName: admin.name, action: action === 'close' ? 'WHATSAPP_CONVERSATION_CLOSED' : 'WHATSAPP_CONVERSATION_RELEASED_TO_BOT', entity: 'WhatsAppConversation', entityId: id, details: conversation.phoneMasked } }).catch(() => {})
      return NextResponse.json({ ok: true, conversation: updated })
    }

    if (action === 'send') {
      const text = String(body?.text || '').trim()
      if (!text) return NextResponse.json({ ok: false, error: 'اكتب الرد قبل الإرسال' }, { status: 400 })
      if (conversation.status !== 'HUMAN_ACTIVE') {
        return NextResponse.json({ ok: false, error: 'يجب استلام المحادثة أولاً قبل الرد من لوحة الإدارة' }, { status: 409 })
      }
      const result = await sendOfficialWhatsAppText(conversation.waId, text, { phoneNumberId: conversation.phoneNumberId || undefined })
      await recordWhatsAppOutboundMessage({
        waId: conversation.waId,
        phoneNumberId: conversation.phoneNumberId || null,
        text,
        sender: 'HUMAN',
        whatsappMessageId: result?.messages?.[0]?.id || null,
        sentById: admin.id,
        sentByName: admin.name,
      })
      if (conversation.handoffRequestId) {
        await db.humanHandoffRequest.updateMany({
          where: { id: conversation.handoffRequestId },
          data: { status: 'CONTACTED', contactedAt: new Date(), assignedToId: admin.id },
        }).catch(() => {})
      }
      await db.auditLog.create({ data: { actorId: admin.id, actorName: admin.name, action: 'WHATSAPP_HUMAN_REPLY_SENT', entity: 'WhatsAppConversation', entityId: id, details: JSON.stringify({ to: conversation.phoneMasked, chars: text.length }) } }).catch(() => {})
      const refreshed = await db.whatsAppConversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } } })
      return NextResponse.json({ ok: true, conversation: refreshed })
    }

    return NextResponse.json({ ok: false, error: 'إجراء غير معروف' }, { status: 400 })
  } catch (error: any) {
    return jsonError(error, String(error?.message) === 'UNAUTHORIZED' ? 401 : 500)
  }
}
