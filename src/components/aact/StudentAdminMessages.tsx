'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

type Conversation = {
  admission: { id: string; reference: string; program: string; status: string }
  lastMessage: { id: string; senderRole: string; content: string; createdAt: string } | null
  unread: number
}

type ThreadMessage = { id: string; senderRole: string; content: string; createdAt: string }

function dateAr(v: string) {
  try { return new Date(v).toLocaleString('ar-EG') } catch { return '' }
}

// رسائل الإدارة للطالب: منطقة مستقلة تماماً عن تبويب الإشراف (نطاق ADMIN فقط).
export function StudentAdminMessages({ initialAdmissionId }: { initialAdmissionId?: string | null }) {
  const { toast } = useToast()
  const [conversations, setConversations] = useState<Conversation[]>([])
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
    return api<{ conversations: Conversation[] }>('/api/my/admin-messages')
  }, [])

  const loadList = useCallback(async () => {
    try {
      const data = await fetchConversations()
      setConversations(Array.isArray(data.conversations) ? data.conversations : [])
    } catch {
      toast({ title: 'تعذر تحميل رسائل الإدارة', variant: 'destructive' })
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
      })
      .catch(() => { if (!cancelled) toast({ title: 'تعذر تحميل رسائل الإدارة', variant: 'destructive' }) })
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
      toast({ title: 'تعذر إرسال الرد', description: String(e?.message || ''), variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const active = conversations.find((c) => c.admission.id === activeId)

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="font-bold">رسائل الإدارة</h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد رسائل من الإدارة بعد.</p>
          ) : (
            <div className="divide-y rounded-xl border">
              {conversations.map((c) => (
                <button key={c.admission.id} type="button" onClick={() => openConversation(c.admission.id)} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-muted/50">
                  <span>
                    <span className="block font-bold">طلب {c.admission.reference} — {c.admission.program || 'برنامج غير محدد'}</span>
                    {c.lastMessage && <span className="block truncate text-sm">{c.lastMessage.senderRole === 'ADMIN' ? 'الإدارة: ' : 'أنت: '}{c.lastMessage.content}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {c.unread > 0 && <Badge>{c.unread} جديد</Badge>}
                    {c.lastMessage && <span className="text-xs text-muted-foreground">{dateAr(c.lastMessage.createdAt)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {activeId && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">محادثة: طلب {active?.admission.reference || ''}</h3>
              <Button variant="outline" onClick={() => setActiveId(null)}>إغلاق</Button>
            </div>
            {messagesLoading ? (
              <p className="text-sm text-muted-foreground">جارٍ تحميل الرسائل…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">لا توجد رسائل بعد.</p>
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {messages.map((m) => (
                  <div key={m.id} className={`rounded-xl border p-3 ${m.senderRole === 'ADMIN' ? 'bg-muted/40' : 'bg-primary/5'}`}>
                    <p className="mb-1 text-[11px] opacity-70">{m.senderRole === 'ADMIN' ? 'الإدارة' : 'أنت'} — {dateAr(m.createdAt)}</p>
                    <p className="whitespace-pre-wrap text-sm">{m.content}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="اكتب ردك للإدارة…" rows={3} />
              <Button onClick={send} disabled={sending || !draft.trim()}>إرسال</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
