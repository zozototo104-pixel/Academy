'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Loader2, MessageCircle, Send, Mic, Square, ClipboardCheck, Bot, UserCheck, BookOpen, CheckCircle2 } from 'lucide-react'
import { SupervisorLiveVoiceCall } from '@/components/aact/SupervisorLiveVoiceCall'

interface Message {
  id: string
  senderRole: string
  content: string
  mode: string
  audioData?: string | null
  audioMime?: string | null
  createdAt: string
}

interface SupervisionRow {
  admission: {
    id: string
    reference: string
    program: string
    status: string
    supervisionMode: string
    supervisor?: { id: string; name: string; email?: string; phone?: string | null } | null
    books: { id: string; title: string; semester?: number | null }[]
    theses: any[]
  }
  messages: Message[]
  assessments: any[]
}

function dateAr(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })
}

function audioSrc(m?: Message) {
  if (!m?.audioData) return ''
  return `data:${m.audioMime || 'audio/webm'};base64,${m.audioData}`
}

function blobToBase64(blob: Blob): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result || '')
      resolve({ data: raw.includes(',') ? raw.split(',')[1] : raw, mime: blob.type || 'audio/webm' })
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function StudentSupervisionTab() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<SupervisionRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, Record<string, any>>>({})
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const active = useMemo(() => rows.find((r) => r.admission.id === activeId) || rows[0] || null, [rows, activeId])

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ supervision: SupervisionRow[]; active: SupervisionRow | null }>('/api/my/supervision')
      const list = d.supervision || []
      setRows(list)
      setActiveId((prev) => prev && list.some((r) => r.admission.id === prev) ? prev : list[0]?.admission.id || null)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل الإشراف', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (payload?: { mode?: 'TEXT' | 'VOICE'; audioData?: string; audioMime?: string; content?: string }) => {
    if (!active) return
    const content = (payload?.content ?? messageText).trim()
    if (!content && !payload?.audioData) return
    setSending(true)
    try {
      await api('/api/supervisor/messages', { method: 'POST', body: JSON.stringify({ admissionId: active.admission.id, content, mode: payload?.mode || 'TEXT', audioData: payload?.audioData, audioMime: payload?.audioMime }) })
      setMessageText('')
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الرسالة', description: e.message, variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast({ title: 'التسجيل غير مدعوم', description: 'استخدم الكتابة حالياً أو افتح الصفحة بمتصفح أحدث.', variant: 'destructive' })
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      recorderRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
          const { data, mime } = await blobToBase64(blob)
          await send({ mode: 'VOICE', audioData: data, audioMime: mime, content: 'ملاحظة صوتية من الطالب' })
        } finally {
          streamRef.current?.getTracks().forEach((t) => t.stop())
          streamRef.current = null
        }
      }
      rec.start()
      setRecording(true)
    } catch (e: any) {
      toast({ title: 'تعذر فتح الميكروفون', description: e.message, variant: 'destructive' })
    }
  }

  const stopRecording = () => {
    setRecording(false)
    try { recorderRef.current?.stop() } catch {}
  }

  const setAnswer = (assessmentId: string, questionId: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [assessmentId]: { ...(prev[assessmentId] || {}), [questionId]: value } }))
  }

  const submitAssessment = async (assessment: any) => {
    setSubmitting(assessment.id)
    try {
      const row = answers[assessment.id] || {}
      const payloadAnswers = assessment.questions.map((q: any) => ({
        questionId: q.id,
        selectedOption: q.type === 'MCQ' || q.type === 'TF' ? row[q.id] : null,
        answerText: q.type === 'MCQ' || q.type === 'TF' ? String(row[q.id] ?? '') : String(row[q.id] || ''),
      }))
      await api('/api/supervisor/assessments', { method: 'POST', body: JSON.stringify({ action: 'submit', assessmentId: assessment.id, answers: payloadAnswers }) })
      toast({ title: 'تم تسليم الاختبار', description: assessment.aiGradingEnabled ? 'تم التصحيح آلياً أو سيظهر فوراً بعد المعالجة.' : 'بانتظار مراجعة المشرف.' })
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر التسليم', description: e.message, variant: 'destructive' })
    } finally {
      setSubmitting(null)
    }
  }

  if (loading) return <div className="flex h-52 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  if (!active) return <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">لا يوجد طلب دراسة مرتبط بحسابك بعد.</div>

  return (
    <div className="space-y-5">
      <Card className="border-[#0f2b46]/10"><CardContent className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0f2b46]"><UserCheck className="ml-1 inline h-5 w-5 text-[#a8841a]" /> إشرافي الأكاديمي</h2>
            <p className="mt-1 text-xs font-bold text-slate-500">{active.admission.program} — <span dir="ltr">{active.admission.reference}</span></p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{active.admission.supervisor?.name ? `مشرفك: ${active.admission.supervisor.name}` : 'مشرف ذكي فقط حالياً'}</Badge>
              <Badge variant="outline">{active.admission.supervisionMode === 'HUMAN' ? 'إشراف بشري' : active.admission.supervisionMode === 'HYBRID' ? 'إشراف بشري وذكي' : 'إشراف ذكي'}</Badge>
            </div>
          </div>
          {rows.length > 1 && (
            <select className="rounded-xl border px-3 py-2 text-xs font-bold" value={active.admission.id} onChange={(e) => setActiveId(e.target.value)}>
              {rows.map((r) => <option key={r.admission.id} value={r.admission.id}>{r.admission.program}</option>)}
            </select>
          )}
        </div>
      </CardContent></Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card className="border-[#0f2b46]/10"><CardContent className="p-5">
          <h3 className="mb-3 text-base font-black text-[#0f2b46]"><MessageCircle className="ml-1 inline h-4 w-4 text-[#a8841a]" /> مراسلة المشرف</h3>
          <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3">
            {active.messages.length ? active.messages.map((m) => {
              const mine = m.senderRole === 'STUDENT'
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[85%] rounded-2xl p-3 text-xs font-bold leading-6 shadow-sm ${mine ? 'bg-[#0f2b46] text-[#f5f0e1]' : 'bg-white text-[#0f2b46]'}`}>
                    <p className="mb-1 text-[10px] opacity-70">{mine ? 'أنت' : m.senderRole === 'AI' ? 'المشرف الذكي' : 'المشرف'} — {dateAr(m.createdAt)}</p>
                    <p>{m.content}</p>
                    {m.audioData && <audio className="mt-2 w-full" controls src={audioSrc(m)} />}
                  </div>
                </div>
              )
            }) : <p className="p-8 text-center text-sm font-bold text-slate-500">لا توجد رسائل بعد. يمكنك بدء محادثة مع مشرفك.</p>}
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
            <Textarea rows={2} value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder="اكتب سؤالك أو أرسل توضيحاً للمشرف..." />
            <div className="flex gap-2 md:flex-col">
              <Button onClick={() => send()} disabled={sending || !messageText.trim()} className="bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]"><Send className="ml-1 h-4 w-4" /> إرسال</Button>
              <Button onClick={recording ? stopRecording : startRecording} disabled={sending} variant="outline" className={recording ? 'border-red-300 font-black text-red-600' : 'font-black'}>{recording ? <Square className="ml-1 h-4 w-4" /> : <Mic className="ml-1 h-4 w-4" />} {recording ? 'إيقاف' : 'صوت'}</Button>
            </div>
          </div>
        </CardContent></Card>

        <Card className="border-[#c9a227]/30 bg-[#fffaf0]"><CardContent className="p-5">
          <h3 className="mb-3 text-base font-black text-[#0f2b46]"><BookOpen className="ml-1 inline h-4 w-4" /> كتبك تحت الإشراف</h3>
          <div className="space-y-2">
            {active.admission.books.length ? active.admission.books.map((b) => <div key={b.id} className="rounded-xl bg-white p-3 text-xs font-bold text-slate-600 ring-1 ring-[#c9a227]/15">{b.title}</div>) : <p className="text-xs font-bold text-slate-500">لا توجد كتب مقررة ظاهرة بعد.</p>}
          </div>
          <div className="mt-4 rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">المشرف يستطيع إنشاء اختبار خاص لك من هذه الكتب وبنك المعرفة، وتصحيحه آلياً أو مراجعته بشرياً.</div>
        </CardContent></Card>
      </div>

      <Card className="border-[#0f2b46]/10"><CardContent className="p-5">
        <h3 className="mb-3 text-base font-black text-[#0f2b46]"><ClipboardCheck className="ml-1 inline h-4 w-4 text-[#a8841a]" /> اختباراتي الخاصة من المشرف</h3>
        {active.assessments.length ? <div className="space-y-4">{active.assessments.map((a) => {
          const last = a.attempts?.[0]
          const already = !!last
          return (
            <div key={a.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="font-black text-[#0f2b46]">{a.title}</h4>
                  <p className="mt-1 text-xs font-bold text-slate-500">{a.questions?.length || 0} سؤال — {a.totalPoints} نقطة — النجاح {a.passScore}% — تصحيح آلي: {a.aiGradingEnabled ? 'نعم' : 'لا'}</p>
                </div>
                {already ? <Badge className={(last.score ?? 0) >= a.passScore ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{last.score ?? 'بانتظار التصحيح'}%</Badge> : <Badge variant="outline">لم يسلّم</Badge>}
              </div>
              {a.description && <p className="mt-2 rounded-xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">{a.description}</p>}
              {already ? (
                <div className="mt-3 rounded-xl bg-[#f8fafc] p-3 text-xs font-bold leading-6 text-slate-600">
                  <p><CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-600" /> تم التسليم: {dateAr(last.submittedAt)} — الحالة: {last.status}</p>
                  {last.feedback && <p className="mt-1 text-[#0f2b46]">{last.feedback}</p>}
                </div>
              ) : (
                <div className="mt-4 space-y-4">
                  {a.questions.map((q: any, idx: number) => (
                    <div key={q.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                      <p className="mb-2 text-sm font-black leading-6 text-[#0f2b46]">{idx + 1}. {q.text}</p>
                      {(q.type === 'MCQ' || q.type === 'TF') ? (
                        <RadioGroup value={String((answers[a.id] || {})[q.id] ?? '')} onValueChange={(v) => setAnswer(a.id, q.id, Number(v))}>
                          {(q.options || ['صح', 'خطأ']).map((op: string, i: number) => (
                            <div key={i} className="flex items-center gap-2 rounded-xl bg-white p-2">
                              <RadioGroupItem value={String(i)} id={`${q.id}-${i}`} />
                              <Label htmlFor={`${q.id}-${i}`} className="cursor-pointer text-xs font-bold leading-5 text-slate-700">{op}</Label>
                            </div>
                          ))}
                        </RadioGroup>
                      ) : (
                        <Textarea rows={3} value={(answers[a.id] || {})[q.id] || ''} onChange={(e) => setAnswer(a.id, q.id, e.target.value)} placeholder="اكتب إجابتك هنا..." />
                      )}
                      {q.sourceBookTitle && <p className="mt-2 text-[10px] font-bold text-[#a8841a]">المصدر: {q.sourceBookTitle}</p>}
                    </div>
                  ))}
                  <Button onClick={() => submitAssessment(a)} disabled={submitting === a.id} className="bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                    {submitting === a.id ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="ml-2 h-4 w-4" />} تسليم الاختبار للمشرف
                  </Button>
                </div>
              )}
            </div>
          )
        })}</div> : (
          <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold leading-7 text-slate-500">
            لم ينشر لك المشرف اختباراً خاصاً بعد. يمكنك مراسلته أو الاستمرار مع المشرف الذكي.
            <br />
            <Bot className="ml-1 inline h-4 w-4 text-[#a8841a]" /> الاختبارات الخاصة ستظهر هنا فور نشرها.
          </div>
        )}
      </CardContent></Card>
    </div>
  )
}
