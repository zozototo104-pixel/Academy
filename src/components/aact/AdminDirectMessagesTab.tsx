'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Conversation = {
  admission: { id: string; reference: string; fullName: string; email: string; program: string; status: string; createdAt: string }
  lastMessage: { id: string; senderRole: string; content: string; createdAt: string } | null
  unread: number
}

type ThreadMessage = { id: string; senderRole: string; content: string; createdAt: string; mode?: string }

function dateAr(v: string) {
  try { return new Date(v).toLocaleString('ar-EG') } catch { return '' }
}

// مراسلة الادارة: محادثات منفصلة تماماً عن الإشراف (نطاق ADMIN فقط)، مع مقدمي
// طلبات الالتحاق فقط. رسائل الإشراف لا تظهر هنا أبداً.
export function AdminDirectMessagesTab({ initialAdmissionId }: { initialAdmissionId?: string | null }) {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  // The thread to open comes from the parent as a prop; it is read once at mount
  // (the parent remounts via key when the target changes), so no effect syncs it.
  const [activeId, setActiveId] = useState<string | null>(initialAdmissionId ?? null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(!!initialAdmissionId)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  // Pure fetcher (no setState) so the mount effect can consume it via promise
  // callbacks instead of calling a state-setting helper from the effect body.
  const fetchConversations = useCallback(async () => {
    return api<{ conversations: Conversation[]; total: number }>(`/api/admin/messages?search=${encodeURIComponent(search)}&page=${page}&pageSize=25`)
  }, [search, page])

  const loadList = useCallback(async () => {
    try {
      const data = await fetchConversations()
      setConversations(Array.isArray(data.conversations) ? data.conversations : [])
      setTotal(data.total || 0)
    } catch {
      toast({ title: 'تعذر تحميل محادثات الإدارة', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [fetchConversations, toast])

  const loadThread = useCallback(async (admissionId: string) => {
    // No synchronous setState here: the mount case is covered by the initial
    // messagesLoading state, and opens from clicks set it in the handler.
    try {
      const data = await api<{ messages: ThreadMessage[] }>(`/api/supervisor/messages?admissionId=${admissionId}&scope=ADMIN`)
      setMessages(Array.isArray(data.messages) ? data.messages : [])
      // Opening the thread marks its notifications read.
      await api('/api/notifications', { method: 'PATCH', body: JSON.stringify({ link: `admin-messages:${admissionId}` }) }).catch(() => {})
    } catch {
      toast({ title: 'تعذر تحميل المحادثة', variant: 'destructive' })
    } finally {
      setMessagesLoading(false)
    }
  }, [toast])

  const mountThreadLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    fetchConversations()
      .then((data) => {
        if (cancelled) return
        setConversations(Array.isArray(data.conversations) ? data.conversations : [])
        setTotal(data.total || 0)
      })
      .catch(() => { if (!cancelled) toast({ title: 'تعذر تحميل محادثات الإدارة', variant: 'destructive' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchConversations, toast])

  // Mount-time thread only: later opens go through openConversation, and closing
  // the thread must not reopen it when the list reloads.
  useEffect(() => {
    if (!mountThreadLoadedRef.current && activeId) {
      mountThreadLoadedRef.current = true
      loadThread(activeId)
    }
  }, [activeId, loadThread])

  const openConversation = (admissionId: string) => {
    mountThreadLoadedRef.current = true
    setActiveId(admissionId)
    setMessages([])
    setDraft('')
    setMessagesLoading(true)
    void loadThread(admissionId)
    loadList()
  }

  // Keep an open conversation fresh when the student replies, without remounting the list.
  useEffect(() => {
    if (!activeId) return
    const refresh = window.setInterval(() => { void loadThread(activeId) }, 25_000)
    return () => window.clearInterval(refresh)
  }, [activeId, loadThread])

  const send = async () => {
    if (!activeId || !draft.trim() || sending) return
    setSending(true)
    try {
      await api('/api/supervisor/messages', { method: 'POST', body: JSON.stringify({ admissionId: activeId, content: draft.trim(), scope: 'ADMIN' }) })
      setDraft('')
      await loadThread(activeId)
      loadList()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الرسالة', description: String(e?.message || ''), variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const active = conversations.find((c) => c.admission.id === activeId)

  return (
    <div className="min-w-0 max-w-full space-y-4 overflow-hidden">
      {!activeId && <Card className="min-w-0 overflow-hidden">
        <CardContent className="min-w-0 space-y-3 p-3 sm:p-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="ابحث باسم الطالب أو البريد…" className="min-w-0 w-full sm:max-w-md" />
            <Button variant="outline" onClick={() => { setLoading(true); loadList() }}>تحديث</Button>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد محادثات بعد. تظهر هنا محادثات مقدمي طلبات الالتحاق فقط.</p>
          ) : (
            <div className="max-h-[65vh] min-w-0 divide-y overflow-y-auto rounded-xl border">
              {conversations.map((c) => (
                <button key={c.admission.id} type="button" onClick={() => openConversation(c.admission.id)} className="flex w-full min-w-0 items-center justify-between gap-2 px-3 py-3 text-right transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
                  <span className="block min-w-0 flex-1 overflow-hidden">
                    <span className="block truncate text-sm font-black text-[#0f2b46]">{c.admission.fullName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{c.admission.program || 'برنامج غير محدد'}</span>
                    {c.lastMessage && <span className="block truncate text-xs text-slate-500">{c.lastMessage.senderRole === 'ADMIN' ? 'أنت: ' : 'الطالب: '}{c.lastMessage.content}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {c.unread > 0 && <Badge>{c.unread} جديد</Badge>}
                    {c.lastMessage && <span className="text-[10px] text-muted-foreground">{new Date(c.lastMessage.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          {total > 25 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</Button>
              <span className="text-sm">صفحة {page} من {Math.max(1, Math.ceil(total / 25))}</span>
              <Button variant="outline" disabled={page >= Math.ceil(total / 25)} onClick={() => setPage(page + 1)}>التالي</Button>
            </div>
          )}
        </CardContent>
      </Card>}

      {activeId && (
        <div className="min-w-0 max-w-full">
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="min-w-0 space-y-3 p-3 sm:p-4">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-base font-black text-[#0f2b46] [overflow-wrap:anywhere]">محادثة: {active?.admission.fullName || 'الطالب'}</h3>
                {active?.admission.program && <p className="mt-1 truncate text-xs text-muted-foreground">{active.admission.program}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={messagesLoading} onClick={() => { setMessagesLoading(true); void loadThread(activeId) }}>تحديث المحادثة</Button>
                <Button variant="outline" size="sm" onClick={() => { setActiveId(null); setMessages([]); setDraft('') }}>العودة للطلاب</Button>
              </div>
            </div>
            {messagesLoading ? (
              <p className="text-sm text-muted-foreground">جارٍ تحميل الرسائل…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">لا توجد رسائل بعد في هذه المحادثة.</p>
            ) : (
              <div className="max-h-[55vh] min-w-0 space-y-2 overflow-y-auto overscroll-contain">
                {messages.map((m) => (
                  <div key={m.id} className={`min-w-0 max-w-full rounded-xl border p-3 ${m.senderRole === 'ADMIN' ? 'bg-primary/5' : 'bg-muted/40'}`}>
                    <p className="mb-1 text-[11px] opacity-70">{m.senderRole === 'ADMIN' ? 'أنت (الإدارة)' : 'الطالب'} — {dateAr(m.createdAt)}</p>
                    <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{m.content}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="اكتب رسالة للطالب…" rows={3} className="min-w-0 max-w-full break-words" />
              <Button onClick={send} disabled={sending || !draft.trim()}>إرسال</Button>
            </div>
          </CardContent>
        </Card>
        </div>
      )}
    </div>
  )
}
