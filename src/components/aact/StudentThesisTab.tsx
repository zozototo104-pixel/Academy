'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertTriangle, BookOpenCheck, CalendarClock, CheckCircle2, ExternalLink, FileText,
  FileUp, Gavel, Loader2, RefreshCw, ScrollText, Sparkles, User2, Users2, Video,
} from 'lucide-react'

const DefenseRoom = dynamic(
  () => import('@/components/aact/DefenseRoom').then((mod) => mod.DefenseRoom),
  { ssr: false }
)

interface ThesisData {
  id: string
  title: string
  abstract: string
  fileNote?: string | null
  status: string
  reviewNote?: string | null
  reviewNotes?: Array<{ id: string; stage: string; action: string; note: string; authorName?: string | null; createdAt: string }>
  defenseDate?: string | null
  committee?: string | null
  agentMember?: string | null
  defenseMeetingUrl?: string | null
  defenseStatus?: string | null
  aiScore?: number | null
  aiRecommendation?: string | null
  defenseMinutes?: string | null
  defenseCompletedAt?: string | null
  recordingUrl?: string | null
  resultScore?: number | null
  passed?: boolean | null
  fileName?: string | null
  fileMime?: string | null
  fileSize?: number | null
  downloadUrl?: string | null
  extractionStatus?: string | null
  extractionError?: string | null
  extractionPagesDone?: number | null
  extractionTotalPages?: number | null
  pageCount?: number | null
  wordCount?: number | null
  extractedAt?: string | null
  createdAt: string
  updatedAt: string
}

interface ThesisPayload {
  thesis: ThesisData | null
  thesisPlan: {
    title: string
    overview?: string | null
    objectives: string[]
    sections: string[]
    activities: string[]
    discussionQuestions: string[]
  } | null
  examsGate: { hasAnyExam: boolean; complete: boolean; missing: Array<{ title: string }> } | null
  admission: {
    id: string
    reference?: string | null
    status: string
    thesisDeadline?: string | null
    supervisorName?: string | null
    program?: { title?: string; titleAr?: string } | null
  } | null
}

const STATUS_LABEL: Record<string, string> = {
  PLAN_SUBMITTED: 'خطة البحث قيد المراجعة',
  PLAN_NEEDS_REVISION: 'الخطة تحتاج تعديلاً',
  PLAN_APPROVED: 'الخطة معتمدة — بانتظار البحث النهائي',
  FINAL_NEEDS_REVISION: 'البحث النهائي يحتاج تعديلاً',
  SUBMITTED: 'البحث النهائي قيد المراجعة',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد نتيجة المناقشة',
  NEEDS_REVISION: 'يحتاج تعديلاً',
}

const UPLOADABLE = ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED']
const CHUNK_SIZE = 4 * 1024 * 1024
const MAX_FILE = 20 * 1024 * 1024

function committeeNames(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean)
  } catch {
    // نص مفصول بفواصل
  }
  return raw.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean)
}

function fmtDate(value?: string | null, withTime = false) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ar-EG', withTime ? { dateStyle: 'full', timeStyle: 'short' } : { dateStyle: 'full' })
}

function fmtSize(bytes?: number | null) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// صفحة بحث التخرج للطالب: الخطة والتسليم ورفع الملف ومعالجته والمناقشة والنتيجة.
export function StudentThesisTab() {
  const { toast } = useToast()
  const [data, setData] = useState<ThesisPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [roomOpen, setRoomOpen] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const processingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(() => {
    api<ThesisPayload>('/api/thesis')
      .then((d) => {
        setData(d)
        setLoadError('')
      })
      .catch((e: any) => setLoadError(e.message || 'تعذر تحميل بيانات البحث'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const thesis = data?.thesis ?? null

  // دفع معالجة الملف (استخراج/تحليل) خطوة بخطوة حتى الجاهزية أو الفشل
  const kickProcessing = useCallback(async () => {
    if (!thesis || processingRef.current) return
    processingRef.current = true
    try {
      for (let i = 0; i < 24; i++) {
        const d = await api<{ thesis?: { extractionStatus?: string } }>(`/api/thesis/${thesis.id}/process-step`, { method: 'POST' })
        const st = d?.thesis?.extractionStatus
        if (!st || st === 'READY' || st === 'FAILED') break
        await new Promise((r) => setTimeout(r, 1200))
      }
    } catch {
      // الخطأ يظهر من حالة الاستخراج بعد إعادة التحميل
    } finally {
      processingRef.current = false
      load()
    }
  }, [thesis, load])

  useEffect(() => {
    if (thesis && ['UPLOADED', 'EXTRACTING', 'ANALYZING'].includes(thesis.extractionStatus || '')) {
      void kickProcessing()
    }
  }, [thesis, kickProcessing])

  const uploadFile = async (file: File) => {
    if (!thesis) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
      toast({ title: 'صيغة غير مدعومة', description: 'يُقبل فقط ملف PDF أو DOCX', variant: 'destructive' })
      return
    }
    if (file.size > MAX_FILE) {
      toast({ title: 'الملف كبير جداً', description: 'الحد الأقصى 20MB', variant: 'destructive' })
      return
    }
    const uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
    const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
    setUploadPct(0)
    try {
      for (let i = 0; i < total; i++) {
        const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        const fd = new FormData()
        fd.set('thesisId', thesis.id)
        fd.set('uploadId', uploadId)
        fd.set('index', String(i))
        fd.set('total', String(total))
        fd.set('fileName', file.name)
        fd.set('mimeType', file.type || '')
        fd.set('chunk', new File([slice], file.name, { type: file.type }))
        await api('/api/thesis/upload-chunk', { method: 'POST', body: fd })
        setUploadPct(Math.round(((i + 1) / total) * 100))
      }
      const done = new FormData()
      done.set('thesisId', thesis.id)
      done.set('uploadId', uploadId)
      done.set('total', String(total))
      done.set('fileName', file.name)
      done.set('mimeType', file.type || '')
      done.set('complete', '1')
      await api('/api/thesis/upload-chunk', { method: 'POST', body: done })
      toast({ title: 'رُفع ملف البحث', description: 'بدأت معالجة الملف (استخراج النص والتحليل) تلقائياً' })
      load()
    } catch (e: any) {
      toast({ title: 'تعذر رفع الملف', description: e.message, variant: 'destructive' })
    } finally {
      setUploadPct(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }

  if (loadError) {
    return (
      <Card className="border-red-200 bg-red-50">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <AlertTriangle className="h-7 w-7 text-red-500" />
          <p className="text-sm font-bold text-red-700">{loadError}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="ml-1 h-4 w-4" /> إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    )
  }

  const admission = data?.admission ?? null
  const gate = data?.examsGate ?? null
  const plan = data?.thesisPlan ?? null
  const canSubmitPlan = !thesis || ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesis.status)
  const canSubmitFinal = thesis && ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION'].includes(thesis.status)
  const committee = committeeNames(thesis?.committee)
  const showDefense = !!thesis && (!!thesis.defenseDate || thesis.status === 'SCHEDULED' || thesis.status === 'RESULT_APPROVED')
  const extraction = thesis?.extractionStatus || null
  const processing = !!extraction && ['UPLOADED', 'EXTRACTING', 'ANALYZING'].includes(extraction)

  return (
    <div className="space-y-4">
      {/* ترويسة المسار */}
      <Card className="border-[#0f2b46]/10 bg-white">
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <ScrollText className="h-5 w-5 text-[#c9a227]" /> بحث التخرج والمناقشة
              </h3>
              <p className="mt-1 text-xs font-bold text-slate-500">
                {admission?.program?.titleAr || admission?.program?.title || 'برنامجك الدراسي'}
                {admission?.reference ? ` · طلب ${admission.reference}` : ''}
              </p>
            </div>
            {thesis && (
              <Badge className={thesis.status === 'RESULT_APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]'}>
                {STATUS_LABEL[thesis.status] || thesis.status}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs font-bold text-slate-600">
            {admission?.supervisorName && (
              <span className="flex items-center gap-1.5">
                <User2 className="h-3.5 w-3.5 text-[#a8841a]" /> المشرف: {admission.supervisorName}
              </span>
            )}
            {admission?.thesisDeadline && (
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5 text-[#a8841a]" /> آخر مهلة لتسليم البحث: {fmtDate(admission.thesisDeadline)}
              </span>
            )}
          </div>
          {!admission && (
            <p className="rounded-xl bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-800 ring-1 ring-amber-200">
              يظهر مسار بحث التخرج بعد إتمام التسجيل النهائي في البرنامج (سداد الرسوم واعتماد الإدارة وتعيين المشرف).
            </p>
          )}
          {gate?.hasAnyExam && !gate.complete && (
            <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
              <p className="flex items-center gap-1.5 text-xs font-black text-amber-800">
                <AlertTriangle className="h-4 w-4" /> تسليم البحث يتطلب اجتياز جميع الامتحانات أولاً
              </p>
              {gate.missing.length > 0 && (
                <p className="mt-1 text-[11px] font-bold leading-relaxed text-amber-700">المتبقي: {gate.missing.map((m) => m.title).join('، ')}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* خطة البرنامج الإرشادية للبحث */}
      {plan && (
        <Card className="border-[#0f2b46]/10 bg-white">
          <CardContent className="space-y-2.5 p-5">
            <h4 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <BookOpenCheck className="h-4 w-4 text-[#a8841a]" /> دليل البحث الإرشادي: {plan.title}
            </h4>
            {plan.overview && <p className="text-xs font-semibold leading-relaxed text-slate-600">{plan.overview}</p>}
            {plan.objectives.length > 0 && (
              <div>
                <p className="text-[11px] font-black text-slate-500">الأهداف:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs font-semibold text-slate-600">
                  {plan.objectives.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.sections.length > 0 && (
              <div>
                <p className="text-[11px] font-black text-slate-500">الأقسام المتوقعة:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs font-semibold text-slate-600">
                  {plan.sections.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* البحث الحالي */}
      {thesis && (
        <Card className="border-[#0f2b46]/10 bg-white">
          <CardContent className="space-y-3 p-5">
            <h4 className="text-base font-black text-[#0f2b46]">{thesis.title}</h4>
            <p className="whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-600">{thesis.abstract}</p>
            {thesis.fileNote && <p className="text-[11px] font-bold text-slate-400">ملاحظتك عند التسليم: {thesis.fileNote}</p>}
            <p className="text-[11px] font-bold text-slate-400">آخر تحديث: {fmtDate(thesis.updatedAt, true)}</p>

            {/* ملاحظات المراجعة */}
            {(thesis.reviewNotes?.length || thesis.reviewNote) && (
              <div className="space-y-2 border-t border-dashed pt-3">
                <p className="text-xs font-black text-[#0f2b46]">ملاحظات الإدارة والمشرف</p>
                {(thesis.reviewNotes || []).map((n) => (
                  <div key={n.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                    <p className="whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-700">{n.note}</p>
                    <p className="mt-1 text-[10px] font-bold text-slate-400">
                      {n.authorName || 'الإدارة'} · {fmtDate(n.createdAt, true)}
                    </p>
                  </div>
                ))}
                {!thesis.reviewNotes?.length && thesis.reviewNote && (
                  <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                    <p className="whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-700">{thesis.reviewNote}</p>
                  </div>
                )}
              </div>
            )}

            {/* ملف البحث والمعالجة */}
            {UPLOADABLE.includes(thesis.status) && (
              <div className="space-y-2.5 border-t border-dashed pt-3">
                <p className="flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                  <FileText className="h-4 w-4 text-[#a8841a]" /> ملف البحث النهائي (PDF أو DOCX — حتى 20MB)
                </p>
                {thesis.fileName ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-600">
                    <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">
                      {thesis.fileName}
                      {thesis.fileSize ? ` · ${fmtSize(thesis.fileSize)}` : ''}
                    </Badge>
                    {thesis.downloadUrl && (
                      <a href={thesis.downloadUrl} className="font-black text-[#a8841a] underline" target="_blank" rel="noreferrer">
                        تحميل الملف
                      </a>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] font-bold text-amber-700">لم يُرفع ملف البحث بعد — ارفعه ليتم تحليله قبل المناقشة.</p>
                )}
                {extraction === 'READY' && (
                  <p className="flex items-center gap-1.5 text-[11px] font-black text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    اكتملت معالجة الملف{thesis.pageCount ? ` — ${thesis.pageCount} صفحة` : ''}{thesis.wordCount ? ` · ${thesis.wordCount} كلمة` : ''}
                  </p>
                )}
                {processing && (
                  <p className="flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    جارٍ استخراج نص الملف وتحليله…
                    {thesis.extractionTotalPages ? ` (${thesis.extractionPagesDone || 0}/${thesis.extractionTotalPages} صفحة)` : ''}
                  </p>
                )}
                {extraction === 'FAILED' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-black text-red-600">فشلت معالجة الملف{thesis.extractionError ? `: ${thesis.extractionError}` : ''}</p>
                    <Button size="sm" variant="outline" onClick={() => void kickProcessing()}>
                      <RefreshCw className="ml-1 h-3.5 w-3.5" /> إعادة المحاولة
                    </Button>
                  </div>
                )}
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void uploadFile(f)
                    }}
                  />
                  <Button size="sm" variant="outline" disabled={uploadPct !== null} onClick={() => fileInputRef.current?.click()} className="font-black">
                    {uploadPct !== null ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <FileUp className="ml-1 h-4 w-4" />}
                    {uploadPct !== null ? `جارٍ الرفع… ${uploadPct}%` : thesis.fileName ? 'استبدال الملف' : 'رفع ملف البحث'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* نموذج التسليم */}
      {admission && (canSubmitPlan || canSubmitFinal) && (
        <ThesisSubmitForm
          key={`${thesis?.id || 'new'}-${canSubmitFinal ? 'FINAL' : 'PLAN'}-${thesis?.updatedAt || ''}`}
          stage={canSubmitFinal ? 'FINAL' : 'PLAN'}
          initialTitle={thesis?.title || ''}
          initialAbstract={thesis?.abstract || ''}
          onDone={load}
        />
      )}
      {thesis?.status === 'PLAN_SUBMITTED' && (
        <Card className="border-[#0f2b46]/10 bg-[#fbf8ef]">
          <CardContent className="p-4 text-center text-xs font-bold leading-relaxed text-slate-600">
            خطتك بانتظار اعتماد الإدارة/المشرف — ستظهر هنا ملاحظاتهم وقرارهم فور صدوره، وبعد الاعتماد يمكنك تسليم البحث النهائي ورفع ملفه.
          </CardContent>
        </Card>
      )}
      {thesis?.status === 'SUBMITTED' && (
        <Card className="border-[#0f2b46]/10 bg-[#fbf8ef]">
          <CardContent className="p-4 text-center text-xs font-bold leading-relaxed text-slate-600">
            بحثك النهائي قيد مراجعة الإدارة — عند جدولة المناقشة سيصلك إشعار بالموعد واللجنة وستفتح هنا قاعة المناقشة.
          </CardContent>
        </Card>
      )}

      {/* المناقشة */}
      {showDefense && thesis && (
        <Card className="border-[#c9a227]/40 bg-[#0f2b46] text-white">
          <CardContent className="space-y-3 p-5">
            <h4 className="flex items-center gap-2 text-base font-black">
              <Gavel className="h-5 w-5 text-[#e0b83a]" /> مناقشة بحث التخرج
            </h4>
            <div className="space-y-1.5 text-xs font-bold text-white/85">
              <p className="flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4 text-[#e0b83a]" /> الموعد: {fmtDate(thesis.defenseDate, true)}
              </p>
              {committee.length > 0 && (
                <p className="flex items-start gap-1.5">
                  <Users2 className="mt-0.5 h-4 w-4 shrink-0 text-[#e0b83a]" /> اللجنة: {committee.join('، ')}
                </p>
              )}
              {thesis.agentMember && <p>عضو الوكيل الدولي: {thesis.agentMember}</p>}
              {thesis.defenseStatus === 'COMPLETED' && (
                <p className="flex items-center gap-1.5 text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> اكتملت المناقشة{thesis.defenseCompletedAt ? ` — ${fmtDate(thesis.defenseCompletedAt, true)}` : ''}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setRoomOpen(true)} className="bg-[#c9a227] font-black text-black hover:bg-[#e0b83a]">
                <Video className="ml-1 h-4 w-4" /> دخول قاعة المناقشة
              </Button>
              {thesis.defenseMeetingUrl && (
                <a
                  href={thesis.defenseMeetingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/40 px-3 py-2 text-xs font-black text-white transition hover:bg-white/10">
                  <ExternalLink className="h-4 w-4" /> الاجتماع الخارجي (Zoom)
                </a>
              )}
              {thesis.recordingUrl && (
                <a
                  href={thesis.recordingUrl}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/40 px-3 py-2 text-xs font-black text-white transition hover:bg-white/10">
                  <FileText className="h-4 w-4" /> تسجيل المناقشة
                </a>
              )}
            </div>
            {(thesis.aiScore != null || thesis.aiRecommendation) && (
              <div className="rounded-xl bg-white/10 p-3 text-xs font-bold leading-relaxed">
                <p className="flex items-center gap-1.5 font-black text-[#e0b83a]">
                  <Sparkles className="h-4 w-4" /> تقييم خبير الذكاء الاصطناعي{thesis.aiScore != null ? `: ${thesis.aiScore}/100` : ''}
                </p>
                {thesis.aiRecommendation && <p className="mt-1 whitespace-pre-wrap text-white/85">{thesis.aiRecommendation}</p>}
              </div>
            )}
            {thesis.defenseMinutes && (
              <details className="rounded-xl bg-white/10 p-3">
                <summary className="cursor-pointer text-xs font-black text-[#e0b83a]">محضر جلسة المناقشة</summary>
                <p className="mt-2 whitespace-pre-wrap text-xs font-semibold leading-relaxed text-white/85">{thesis.defenseMinutes}</p>
              </details>
            )}
            {thesis.status === 'RESULT_APPROVED' && thesis.resultScore != null && (
              <div className="flex items-center gap-3 rounded-xl bg-white/10 p-3">
                <span className="text-2xl font-black text-[#e0b83a]">{thesis.resultScore}</span>
                <span className="text-xs font-bold leading-relaxed">
                  الدرجة النهائية للمناقشة
                  <br />
                  {thesis.passed ? 'النتيجة: ناجح — مبارك!' : 'النتيجة: لم يجتز — راجع ملاحظات اللجنة أعلاه'}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* نافذة قاعة المناقشة */}
      <Dialog open={roomOpen} onOpenChange={setRoomOpen}>
        <DialogContent className="max-h-[95vh] max-w-4xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Video className="h-5 w-5 text-[#a8841a]" /> قاعة مناقشة بحث التخرج
            </DialogTitle>
            <DialogDescription>{thesis?.title}</DialogDescription>
          </DialogHeader>
          {thesis && roomOpen && (
            <DefenseRoom
              thesis={{
                id: thesis.id,
                title: thesis.title,
                abstract: thesis.abstract,
                defenseDate: thesis.defenseDate,
                committee: thesis.committee,
                agentMember: thesis.agentMember,
                defenseMeetingUrl: thesis.defenseMeetingUrl,
                defenseStatus: thesis.defenseStatus,
                aiScore: thesis.aiScore,
                aiRecommendation: thesis.aiRecommendation,
                defenseMinutes: thesis.defenseMinutes,
              }}
              mode="student"
              onFinished={load}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ThesisSubmitForm({
  stage,
  initialTitle,
  initialAbstract,
  onDone,
}: {
  stage: 'PLAN' | 'FINAL'
  initialTitle: string
  initialAbstract: string
  onDone: () => void
}) {
  const { toast } = useToast()
  const [title, setTitle] = useState(initialTitle)
  const [abstract, setAbstract] = useState(initialAbstract)
  const [fileNote, setFileNote] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!title.trim() || abstract.trim().length < 50) {
      toast({ title: 'بيانات ناقصة', description: 'العنوان مطلوب والملخص لا يقل عن 50 حرفاً', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      await api('/api/thesis', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), abstract: abstract.trim(), fileNote: fileNote.trim(), stage }),
      })
      toast({
        title: stage === 'PLAN' ? 'سُلّمت خطة البحث' : 'سُلّم البحث النهائي',
        description: 'وصلت الإدارة وستظهر ملاحظاتهم هنا فور مراجعتها',
      })
      onDone()
    } catch (e: any) {
      toast({ title: 'تعذر التسليم', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-[#0f2b46]/10 bg-white">
      <CardContent className="space-y-3 p-5">
        <h4 className="text-sm font-black text-[#0f2b46]">{stage === 'PLAN' ? 'تسليم خطة البحث' : 'تسليم البحث النهائي'}</h4>
        <div className="space-y-1.5">
          <Label>عنوان البحث *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان بحث التخرج" maxLength={300} />
        </div>
        <div className="space-y-1.5">
          <Label>ملخص البحث * (50 حرفاً على الأقل — {abstract.trim().length} حرف)</Label>
          <Textarea value={abstract} onChange={(e) => setAbstract(e.target.value)} rows={5} maxLength={4000} placeholder="اكتب ملخصاً واضحاً لمشكلة البحث وأهدافه ومنهجيته…" />
        </div>
        <div className="space-y-1.5">
          <Label>ملاحظة للإدارة (اختياري)</Label>
          <Input value={fileNote} onChange={(e) => setFileNote(e.target.value)} maxLength={600} />
        </div>
        <Button onClick={submit} disabled={busy} className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
          {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileUp className="ml-2 h-4 w-4" />}
          {stage === 'PLAN' ? 'إرسال الخطة للاعتماد' : 'إرسال البحث النهائي'}
        </Button>
        {stage === 'FINAL' && (
          <p className="text-[11px] font-bold leading-relaxed text-slate-400">بعد الإرسال يظهر هنا قسم رفع ملف البحث النهائي (PDF/DOCX) ليُحلَّل قبل المناقشة.</p>
        )}
      </CardContent>
    </Card>
  )
}
