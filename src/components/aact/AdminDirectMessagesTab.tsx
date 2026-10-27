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

  const threadRef = useRef<HTMLDivElement>(null)
  // فتح المحادثة يرسم بطاقتها أسفل القائمة، فبدون تمرير يبقى الشاشة على
  // القائمة ويظن المسؤول أن الضغطة لم تعمل — ننزل مباشرة إلى المحادثة.
  useEffect(() => {
    if (!activeId) return
    const t = setTimeout(() => {
      threadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 120)
    return () => clearTimeout(t)
  }, [activeId])

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
    setActiveId(admissionId)
    setMessagesLoading(true)
    loadThread(admissionId)
    loadList()
  }

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
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="ابحث بالاسم أو البريد أو رقم الطلب…" className="max-w-md" />
            <Button variant="outline" onClick={() => { setLoading(true); loadList() }}>تحديث</Button>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد محادثات بعد. تظهر هنا محادثات مقدمي طلبات الالتحاق فقط.</p>
          ) : (
            <div className="divide-y rounded-xl border">
              {conversations.map((c) => (
                <button key={c.admission.id} type="button" onClick={() => openConversation(c.admission.id)} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-muted/50">
                  <span>
                    <span className="block font-bold">{c.admission.fullName} <span className="font-normal text-muted-foreground">({c.admission.reference})</span></span>
                    <span className="block text-xs text-muted-foreground">{c.admission.email} — {c.admission.program || 'برنامج غير محدد'}</span>
                    {c.lastMessage && <span className="block truncate text-sm">{c.lastMessage.senderRole === 'ADMIN' ? 'أنت: ' : 'الطالب: '}{c.lastMessage.content}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {c.unread > 0 && <Badge>{c.unread} جديد</Badge>}
                    {c.lastMessage && <span className="text-xs text-muted-foreground">{dateAr(c.lastMessage.createdAt)}</span>}
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
      </Card>

      {activeId && (
        <div ref={threadRef}>
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">محادثة: {active?.admission.fullName || 'طالب'} ({active?.admission.reference || ''})</h3>
              <Button variant="outline" onClick={() => setActiveId(null)}>إغلاق</Button>
            </div>
            {messagesLoading ? (
              <p className="text-sm text-muted-foreground">جارٍ تحميل الرسائل…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">لا توجد رسائل بعد في هذه المحادثة.</p>
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {messages.map((m) => (
                  <div key={m.id} className={`rounded-xl border p-3 ${m.senderRole === 'ADMIN' ? 'bg-primary/5' : 'bg-muted/40'}`}>
                    <p className="mb-1 text-[11px] opacity-70">{m.senderRole === 'ADMIN' ? 'أنت (الإدارة)' : 'الطالب'} — {dateAr(m.createdAt)}</p>
                    <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="اكتب رسالة للطالب…" rows={3} />
              <Button onClick={send} disabled={sending || !draft.trim()}>إرسال</Button>
            </div>
          </CardContent>
        </Card>
        </div>
      )}
    </div>
  )
}
