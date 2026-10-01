'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowRight, Loader2, MessageCircle, Send, UserCheck, Lock, Bot, CheckCircle2 } from 'lucide-react'

type WaMessage = {
  id: string
  direction: 'INBOUND' | 'OUTBOUND'
  sender: 'CUSTOMER' | 'BOT' | 'HUMAN' | 'SYSTEM'
  text: string
  sentByName?: string | null
  createdAt: string
}

type WaConversation = {
  id: string
  phoneMasked: string
  displayName?: string | null
  status: 'BOT_ACTIVE' | 'HUMAN_REQUESTED' | 'HUMAN_ACTIVE' | 'CLOSED'
  assignedToName?: string | null
  lastMessageText?: string | null
  lastMessageAt: string
  messages?: WaMessage[]
}

const statusLabel: Record<string, string> = {
  BOT_ACTIVE: 'الوكيل يرد',
  HUMAN_REQUESTED: 'طلب موظف',
  HUMAN_ACTIVE: 'مع موظف',
  CLOSED: 'مغلقة',
}

function formatTime(value?: string) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString('ar', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
  } catch { return '' }
}

function statusTone(status: string) {
  if (status === 'HUMAN_ACTIVE') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (status === 'HUMAN_REQUESTED') return 'bg-amber-50 text-amber-700 border-amber-200'
  if (status === 'CLOSED') return 'bg-slate-100 text-slate-500 border-slate-200'
  return 'bg-blue-50 text-blue-700 border-blue-200'
}

export function AdminWhatsAppInboxTab() {
  const { toast } = useToast()
  const [conversations, setConversations] = useState<WaConversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WaConversation | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('HUMAN_REQUESTED')
  const [reply, setReply] = useState('')
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const activeConversation = selected || conversations.find((c) => c.id === selectedId) || null

  async function loadList(options?: { silent?: boolean; preserveSelected?: boolean }) {
    if (!options?.silent) setLoading(true)
    const params = new URLSearchParams()
    if (status !== 'ALL') params.set('status', status)
    if (search.trim()) params.set('search', search.trim())
    try {
      const data = await api<{ conversations: WaConversation[] }>(`/api/admin/whatsapp-conversations?${params.toString()}`)
      const list = data.conversations || []
      setConversations(list)
      setSelected((prev) => {
        if (!prev) return prev
        const refreshed = list.find((c) => c.id === prev.id)
        if (refreshed) return { ...prev, ...refreshed, messages: prev.messages }
        return options?.preserveSelected ? prev : null
      })
      setSelectedId((current) => {
        if (current && (options?.preserveSelected || list.some((c) => c.id === current))) return current
        const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
        return isDesktop && list[0] ? list[0].id : null
      })
    } catch (e: any) {
      if (!options?.silent) toast({ title: 'تعذر تحميل محادثات واتساب', description: e?.message, variant: 'destructive' })
    } finally {
      if (!options?.silent) setLoading(false)
      setLastSyncAt(new Date())
    }
  }

  async function loadDetail(id: string, options?: { silent?: boolean }) {
    if (!options?.silent) setDetailLoading(true)
    try {
      const data = await api<{ conversation: WaConversation }>(`/api/admin/whatsapp-conversations?id=${encodeURIComponent(id)}`)
      setSelected(data.conversation)
    } catch (e: any) {
      if (!options?.silent) toast({ title: 'تعذر فتح المحادثة', description: e?.message, variant: 'destructive' })
    } finally {
      if (!options?.silent) setDetailLoading(false)
      setLastSyncAt(new Date())
    }
  }

  async function act(action: 'claim' | 'release' | 'close') {
    if (!activeConversation) return
    try {
      const data = await api<{ conversation: WaConversation }>('/api/admin/whatsapp-conversations', {
        method: 'POST',
        body: JSON.stringify({ id: activeConversation.id, action }),
      })
      setSelected((prev) => prev?.id === data.conversation.id ? { ...prev, ...data.conversation } : prev)
      await loadList()
      toast({ title: action === 'claim' ? 'تم استلام المحادثة' : action === 'release' ? 'تم إرجاعها للوكيل' : 'تم إغلاق المحادثة' })
    } catch (e: any) {
      toast({ title: 'تعذر تنفيذ الإجراء', description: e?.message, variant: 'destructive' })
    }
  }

  async function sendReply() {
    if (!activeConversation || !reply.trim()) return
    setSending(true)
    try {
      const data = await api<{ conversation: WaConversation }>('/api/admin/whatsapp-conversations', {
        method: 'POST',
        body: JSON.stringify({ id: activeConversation.id, action: 'send', text: reply.trim() }),
      })
      setSelected(data.conversation)
      setReply('')
      await loadList()
      toast({ title: 'تم إرسال الرد من رقم الأكاديمية' })
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الرد', description: e?.message, variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(loadList, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  useEffect(() => {
    const timer = window.setTimeout(loadList, 350)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  useEffect(() => {
    if (!selectedId) return
    const timer = window.setTimeout(() => loadDetail(selectedId), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return
      loadList({ silent: true })
      if (selectedId) loadDetail(selectedId, { silent: true })
    }, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, status, search])

  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation])

  useEffect(() => {
    const timer = window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 80)
    return () => window.clearTimeout(timer)
  }, [messages.length, selectedId, detailLoading])

  return (
    <Card className="border-emerald-100 bg-gradient-to-br from-white to-emerald-50/40 shadow-sm">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-lg font-black text-[#0f2b46]"><MessageCircle className="h-5 w-5 text-emerald-600" /> صندوق محادثات واتساب</p>
            <p className="text-xs font-bold text-slate-500">تظهر طلبات الموظف افتراضيًا، ويمكنك تبديل الفلتر لكل المحادثات. الوكيل يظل يرد تلقائيًا إلى أن يضغط الموظف على استلام المحادثة.</p>
          </div>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button
              variant="outline"
              onClick={() => {
                loadList()
                if (selectedId) loadDetail(selectedId)
              }}
              className="rounded-2xl font-black"
            >تحديث الآن</Button>
            <span className="text-[10px] font-bold text-slate-400">
              تحديث تلقائي كل 5 ثوانٍ{lastSyncAt ? ` · آخر مزامنة ${lastSyncAt.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          </div>
        </div>

        <div className="grid gap-4 lg:h-[720px] lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className={`${activeConversation ? 'hidden lg:flex' : 'flex'} min-h-[560px] flex-col space-y-3 rounded-3xl border border-slate-100 bg-white p-3 lg:h-full lg:min-h-0`}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالرقم أو الاسم أو آخر رسالة..." className="rounded-2xl text-sm font-bold" />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="rounded-2xl font-bold"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل المحادثات</SelectItem>
                <SelectItem value="HUMAN_REQUESTED">طلبات موظف</SelectItem>
                <SelectItem value="HUMAN_ACTIVE">مع موظف</SelectItem>
                <SelectItem value="BOT_ACTIVE">الوكيل يرد</SelectItem>
                <SelectItem value="CLOSED">مغلقة</SelectItem>
              </SelectContent>
            </Select>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {loading ? (
                <div className="flex h-28 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
              ) : conversations.length ? conversations.map((c) => (
                <button key={c.id} onClick={() => setSelectedId(c.id)} className={`w-full rounded-3xl border p-3 text-right transition ${selectedId === c.id ? 'border-[#0f2b46] bg-[#0f2b46] text-white' : 'border-slate-100 bg-slate-50 hover:bg-white'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-black">{c.displayName || c.phoneMasked}</span>
                    <Badge className={`${statusTone(c.status)} border text-[10px]`}>{statusLabel[c.status]}</Badge>
                  </div>
                  <p className={`mt-1 line-clamp-2 text-xs font-bold ${selectedId === c.id ? 'text-blue-100' : 'text-slate-500'}`}>{c.lastMessageText || 'لا توجد رسائل محفوظة بعد'}</p>
                  <p className={`mt-1 text-[10px] font-bold ${selectedId === c.id ? 'text-blue-200' : 'text-slate-400'}`}>{formatTime(c.lastMessageAt)}</p>
                </button>
              )) : <p className="rounded-2xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-400">لا توجد محادثات مطابقة.</p>}
            </div>
          </div>

          <div className={`${activeConversation ? 'flex' : 'hidden lg:flex'} h-[calc(100svh-220px)] min-h-[560px] flex-col overflow-hidden rounded-3xl border border-slate-100 bg-[#efe7dc] lg:h-full lg:min-h-0`}>
            {activeConversation ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 bg-[#075e54] p-4 text-white">
                  <div className="flex min-w-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setSelectedId(null); setSelected(null) }}
                      className="rounded-2xl px-2 text-white hover:bg-white/10 lg:hidden"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                    <div className="min-w-0">
                      <p className="truncate text-base font-black">{activeConversation.displayName || activeConversation.phoneMasked}</p>
                      <p className="truncate text-[11px] font-bold text-emerald-100">{statusLabel[activeConversation.status]} {activeConversation.assignedToName ? `— ${activeConversation.assignedToName}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {activeConversation.status !== 'HUMAN_ACTIVE' && <Button size="sm" onClick={() => act('claim')} className="rounded-2xl bg-white text-[#075e54] hover:bg-emerald-50"><UserCheck className="ml-1 h-4 w-4" /> استلام</Button>}
                    {activeConversation.status === 'HUMAN_ACTIVE' && <Button size="sm" variant="outline" onClick={() => act('release')} className="rounded-2xl border-white/50 bg-transparent text-white hover:bg-white/10"><Bot className="ml-1 h-4 w-4" /> إرجاع للوكيل</Button>}
                    {activeConversation.status === 'HUMAN_ACTIVE' && <Button size="sm" variant="outline" onClick={() => act('close')} className="rounded-2xl border-white/50 bg-transparent text-white hover:bg-white/10"><CheckCircle2 className="ml-1 h-4 w-4" /> إغلاق</Button>}
                  </div>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                  {detailLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#075e54]" /></div> : messages.map((m) => {
                    const outbound = m.direction === 'OUTBOUND'
                    return (
                      <div key={m.id} className={`flex ${outbound ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[82%] rounded-3xl px-4 py-3 shadow-sm ${outbound ? 'rounded-bl-md bg-[#dcf8c6]' : 'rounded-br-md bg-white'}`}>
                          <p className="whitespace-pre-wrap text-sm font-bold leading-7 text-[#102a43]">{m.text}</p>
                          <p className="mt-1 text-left text-[10px] font-bold text-slate-400">{m.sender === 'HUMAN' && m.sentByName ? `${m.sentByName} · ` : ''}{formatTime(m.createdAt)}</p>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t border-black/5 bg-[#f0f2f5] p-3">
                  {activeConversation.status === 'HUMAN_ACTIVE' ? (
                    <div className="flex items-end gap-2">
                      <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="اكتب رد الموظف هنا..." className="min-h-12 rounded-3xl bg-white text-sm font-bold leading-7" />
                      <Button onClick={sendReply} disabled={sending || !reply.trim()} className="h-12 rounded-full bg-[#075e54] px-4">
                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 text-xs font-bold text-slate-500">
                      <Lock className="h-4 w-4" /> اضغط استلام المحادثة أولاً للرد من نفس رقم الأكاديمية. قبل الاستلام يبقى الوكيل يرد تلقائياً.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-center text-sm font-bold text-slate-500">اختر محادثة من القائمة.</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
