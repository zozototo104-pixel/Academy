'use client'

import { api } from '@/lib/store'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Loader2, Bot, Mic, FileSearch, MessageCircle, User2 } from 'lucide-react'

interface StudentRow {
  id: string
  name: string
  email: string
  country?: string | null
  total: number
  voice: number
  lastAt: string | null
}

interface LogMsg {
  id: string
  role: string
  content: string
  mode: string
  kind: string | null
  createdAt: string
}

/**
 * 12.1 — سجل المشرف الذكي: كل محادثات كل طالب (نصية وصوتية مع النسخ المفرّغ)
 * وتحليلات مسودات البحث — متاح للمشرف الأكاديمي البشري والإدارة للرجوع إليه
 */
export function AdminAITab() {
  const { toast } = useToast()
  const [students, setStudents] = useState<StudentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<StudentRow | null>(null)
  const [messages, setMessages] = useState<LogMsg[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)

  const load = useCallback(() => {
    api<{ students: StudentRow[] }>('/api/admin/chats')
      .then((d) => setStudents(d.students))
      .catch((e: any) => toast({ title: 'خطأ', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [toast])

  useEffect(load, [load])

  const openStudent = async (s: StudentRow) => {
    setActive(s)
    setLoadingMsgs(true)
    try {
      const d = await api<{ messages: LogMsg[] }>(`/api/admin/chats?userId=${s.id}`)
      setMessages(d.messages)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoadingMsgs(false)
    }
  }

  if (loading) {
    return <div className="mt-4 flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-[11px] font-bold leading-relaxed text-emerald-800">
        وفق سياسة الشفافية والأرشفة: كل محادثات الطالب مع المشرف الذكي (نصية وصوتية مع النسخ المفرّغ) وتحليلات مسودات بحثه
        تُحفظ في ملفه — متاحة لك كمشرف بشري/إدارة لمتابعة تقدمه والتدخل عند الحاجة.
      </div>

      {students.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد محادثات مع المشرف الذكي بعد</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {students.map((s) => (
            <Card key={s.id} className="cursor-pointer border-[#0f2b46]/10 transition-shadow hover:shadow-md" onClick={() => openStudent(s)}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-xs font-black text-[#0f2b46]">{s.name}</h3>
                    <p className="truncate text-[10px] font-bold text-slate-400" dir="ltr">{s.email}</p>
                  </div>
                  <div className="shrink-0 rounded-lg bg-[#0f2b46] p-1.5 text-[#e0b83a]"><Bot className="h-4 w-4" /></div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <Badge className="bg-[#f7edd0] text-[9px] font-black text-[#a8841a] hover:bg-[#f7edd0]">
                    <MessageCircle className="ml-1 h-2.5 w-2.5" /> {s.total} رسالة
                  </Badge>
                  {s.voice > 0 && (
                    <Badge className="bg-emerald-100 text-[9px] font-black text-emerald-700 hover:bg-emerald-100">
                      <Mic className="ml-1 h-2.5 w-2.5" /> {s.voice} صوتية
                    </Badge>
                  )}
                </div>
                {s.lastAt && (
                  <p className="mt-1.5 text-[10px] font-bold text-slate-400">
                    آخر تفاعل: {new Date(s.lastAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* نافذة المحادثة الكاملة */}
      <Dialog open={!!active} onOpenChange={(v) => !v && setActive(null)}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Bot className="h-5 w-5 text-[#a8841a]" /> سجل {active?.name} مع المشرف الذكي
            </DialogTitle>
            <DialogDescription>
              {active?.total} رسالة ({active?.voice} صوتية مع نسخ مفرّغ) — تُقرأ من الطالب وإدارة فقط
            </DialogDescription>
          </DialogHeader>

          {loadingMsgs ? (
            <div className="flex h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => {
                const isUser = m.role === 'user'
                return (
                  <div key={m.id} className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-[#c9a227] text-[#0f2b46]' : 'bg-[#0f2b46] text-[#e0b83a]'}`}>
                      {isUser ? <User2 className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    </div>
                    <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${isUser ? 'rounded-br-sm bg-[#0f2b46] text-white' : 'rounded-bl-sm bg-[#f7edd0] text-[#0f2b46]'}`}>
                      <div className="mb-1 flex flex-wrap items-center gap-1">
                        {m.mode === 'VOICE' && (
                          <Badge className="gap-0.5 bg-emerald-100 text-[8px] font-black text-emerald-700 hover:bg-emerald-100">
                            <Mic className="h-2 w-2" /> صوتي (مفرّغ)
                          </Badge>
                        )}
                        {m.kind === 'THESIS_REVIEW' && (
                          <Badge className="bg-[#c9a227] text-[8px] font-black text-[#0f2b46] hover:bg-[#c9a227]">
                            <FileSearch className="h-2 w-2" /> تحليل مسودة بحث
                          </Badge>
                        )}
                        <span className={`text-[9px] font-bold ${isUser ? 'text-white/50' : 'text-[#a8841a]/60'}`}>
                          {new Date(m.createdAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    </div>
                  </div>
                )
              })}
              <div className="pt-2 text-center">
                <Button size="sm" variant="outline" onClick={load} className="border-slate-200 text-[10px] font-bold text-slate-500">
                  تحديث السجل
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
