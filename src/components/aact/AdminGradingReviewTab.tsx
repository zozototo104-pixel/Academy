'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { ChevronDown, ChevronLeft, ShieldCheck } from 'lucide-react'

type ApprovalState = 'APPROVED' | 'STALE' | 'NONE' | null
type ReviewAttempt = { type: 'UNIT' | 'PROGRAM'; id: string; status?: string; score?: number | null; approvalState?: ApprovalState; submittedAt: string; student: { id?: string; name: string; email: string }; exam: { title: string; programTitle?: string; unitTitle?: string } }
type ReviewDetail = { type: 'UNIT' | 'PROGRAM'; id: string; status?: string; answers: Array<{ answerId: string; order: number; questionType?: string; question: string; studentAnswer: string; modelAnswer: string; source: string; points: number | null; maxPoints: number; aiFeedback: string | null }> }
type BulkReport = { approved: number; alreadyApproved: number; rejected: number; results?: Array<{ ok: boolean; code?: string }> }

const studentKey = (a: ReviewAttempt) => a.student.id || a.student.email
const isApprovable = (a: ReviewAttempt) => a.status === 'GRADED' && a.approvalState !== 'APPROVED'

function ApprovalBadge({ state }: { state: ApprovalState | undefined }) {
  if (state === 'APPROVED') return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">مصادقة رسميًا</Badge>
  if (state === 'STALE') return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">مصادقة قديمة — الدرجة تغيّرت</Badge>
  if (state === 'NONE') return <Badge className="bg-red-50 text-red-700 hover:bg-red-50">غير مصادقة</Badge>
  return null
}

export default function AdminGradingReviewTab() {
  const { toast } = useToast()
  const [attempts, setAttempts] = useState<ReviewAttempt[]>([])
  const [selected, setSelected] = useState<ReviewDetail | null>(null)
  const [scores, setScores] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'regrade' | 'approve' | 'approve-grade' | null>(null)
  const [statusFilter, setStatusFilter] = useState<'NEEDS_REVIEW' | 'GRADED' | 'ALL'>('NEEDS_REVIEW')
  // null = لم يلمس الإداري التجميع بعد → أول طالب مفتوح افتراضيًا.
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [armBulk, setArmBulk] = useState<string | null>(null)
  const [bulkReport, setBulkReport] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ attempts: ReviewAttempt[] }>(`/api/admin/attempts-review?status=${statusFilter}`)
      setAttempts(res.attempts || [])
    } finally { setLoading(false) }
  }, [statusFilter])

  // التجميع حسب الطالب: تدخل على الطالب فترى كل امتحاناته وحالة مصادقة
  // كل درجة — بدل قائمة مسطّحة تختلط فيها محاولات الجميع.
  const groups = useMemo(() => {
    const byStudent = new Map<string, { key: string; name: string; email: string; items: ReviewAttempt[] }>()
    for (const a of attempts) {
      const key = studentKey(a)
      if (!byStudent.has(key)) byStudent.set(key, { key, name: a.student.name, email: a.student.email, items: [] })
      byStudent.get(key)!.items.push(a)
    }
    return [...byStudent.values()]
  }, [attempts])

  const isExpanded = (key: string, index: number) => (expanded === null ? index === 0 : expanded.has(key))

  const toggleStudent = (key: string, index: number) =>
    setExpanded((prev) => {
      const base = prev ?? new Set(groups[0] ? [groups[0].key] : [])
      const next = new Set(base)
      if (index === 0 && prev === null) {
        // أول لمسة على المجموعة الافتراضية: إغلاقها صراحة.
        next.delete(key)
        return next
      }
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const open = async (item: ReviewAttempt) => {
    const res = await api<{ attempt: ReviewDetail }>(`/api/admin/attempts-review?type=${item.type}&id=${item.id}`)
    setSelected(res.attempt)
    setScores(Object.fromEntries((res.attempt?.answers || []).map((a) => [a.answerId, String(a.points ?? '')])))
  }

  const regrade = async () => {
    if (!selected) return
    setBusy('regrade')
    try {
      const res = await api(`/api/admin/attempts-review`, { method: 'POST', body: JSON.stringify({ type: selected.type, attemptId: selected.id }) })
      toast({ title: 'تمت إعادة التصحيح الآلي', description: `النتيجة: ${(res as any).score ?? ''}` })
      setSelected(null)
      await load()
    } catch (error: any) {
      toast({ title: 'تعذر إعادة التصحيح الآلي', description: String(error?.message || error), variant: 'destructive' })
      if (String(error?.message || '').includes('تم اعتماد هذه المحاولة مسبقاً')) {
        setSelected(null)
        await load()
      }
    } finally {
      setBusy(null)
    }
  }

  const markReview = async () => {
    if (!selected) return
    setBusy('regrade')
    try {
      await api(`/api/admin/attempts-review`, { method: 'POST', body: JSON.stringify({ type: selected.type, attemptId: selected.id, action: 'MARK_NEEDS_REVIEW' }) })
      toast({ title: 'نُقلت المحاولة إلى قائمة المراجعة' })
      setSelected(null)
      await load()
    } catch (error: any) {
      toast({ title: 'تعذر نقل المحاولة', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const approve = async () => {
    if (!selected) return
    setBusy('approve')
    try {
      const res = await api(`/api/admin/attempts-review`, { method: 'PATCH', body: JSON.stringify({ type: selected.type, attemptId: selected.id, scores }) })
      toast({ title: 'تم اعتماد نتيجة المراجعة', description: `النتيجة: ${(res as any).score ?? ''}` })
      setSelected(null)
      await load()
    } catch (error: any) {
      toast({ title: 'تعذر اعتماد نتيجة المراجعة', description: String(error?.message || error), variant: 'destructive' })
      if (String(error?.message || '').includes('تم اعتماد هذه المحاولة مسبقاً')) {
        setSelected(null)
        await load()
      }
    } finally {
      setBusy(null)
    }
  }

  // مصادقة الدرجة رسميًا (المرحلة 2): صلاحية الإدارة الأصلية الكاملة
  // بالتوازي مع المشرف — سجل اعتماد محفوظ مستقل عن اعتماد نتيجة المراجعة
  // أعلاه، والخادم يرفض أي درجة غير نهائية. ضغطة ثانية على درجة مصادقة
  // بنفس القيمة لا تغيّر شيئًا (الخادم يرجع alreadyApproved).
  const approveOfficial = async () => {
    if (!selected) return
    setBusy('approve-grade')
    try {
      const res = await api<{ alreadyApproved?: boolean }>(`/api/admin/grade-approvals`, { method: 'POST', body: JSON.stringify({ targetType: selected.type === 'UNIT' ? 'UNIT_EXAM' : 'PROGRAM_EXAM', attemptId: selected.id }) })
      toast({
        title: res?.alreadyApproved ? 'هذه الدرجة مصادقة أصلًا بنفس القيمة' : 'تمت مصادقة الدرجة رسميًا',
        description: res?.alreadyApproved ? 'لم يتغير شيء — الاعتماد السابق سارٍ ولم يُكتب سجل جديد.' : 'الاعتماد محفوظ بسجلّه، وأي تعديل لاحق على الدرجة يُبطله تلقائيًا.',
      })
      setSelected(null)
      await load()
    } catch (error: any) {
      toast({ title: 'تعذرت مصادقة الدرجة', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  // مصادقة جماعية على قائمة معروضة قبل التنفيذ: القائمة هي بالضبط
  // الدرجات النهائية غير المصادقة ضمن النطاق المختار (طالب واحد أو
  // كل القائمة)، والخادم يعيد مصادقة كل عنصر ببوابته المفردة ويرجع
  // تقريرًا بكل نتيجة.
  const runBulk = async (key: string, items: ReviewAttempt[]) => {
    const targets = items.filter(isApprovable)
    if (!targets.length) return
    if (armBulk !== key) { setArmBulk(key); return }
    setBulkBusy(key)
    setArmBulk(null)
    try {
      const res = await api<{ report: BulkReport }>(`/api/admin/grade-approvals`, {
        method: 'POST',
        body: JSON.stringify({
          bulk: true,
          items: targets.map((a) => ({ targetType: a.type === 'UNIT' ? 'UNIT_EXAM' : 'PROGRAM_EXAM', attemptId: a.id })),
        }),
      })
      const r = res.report
      const internalFailures = (r.results || []).filter((item) => item.code === 'INTERNAL_ERROR').length
      const rejectedByRules = r.rejected - internalFailures
      setBulkReport(`نتيجة المصادقة الجماعية: صُدّقت ${r.approved} درجة الآن، و${r.alreadyApproved} كانت مصادقة أصلًا، ورُفضت ${rejectedByRules} بسبب شروط المصادقة${internalFailures ? `، وتعذرت ${internalFailures} بسبب خطأ خادم (يمكن إعادة المحاولة بأمان)` : ''}.`)
      toast({
        title: internalFailures ? 'اكتملت الدفعة مع أخطاء خادم' : 'اكتملت المصادقة الجماعية',
        description: `جديدة: ${r.approved} · سابقة: ${r.alreadyApproved} · مرفوضة: ${rejectedByRules} · أخطاء خادم: ${internalFailures}`,
        ...(internalFailures ? { variant: 'destructive' as const } : {}),
      })
      await load()
    } catch (error: any) {
      toast({ title: 'تعذرت المصادقة الجماعية', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBulkBusy(null)
    }
  }

  const allApprovable = attempts.filter(isApprovable)

  useEffect(() => { void load() }, [load])

  return (
    <div className="mt-4 grid w-full min-w-0 max-w-full gap-4 overflow-x-hidden lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]" dir="rtl">
      <Card className="w-full min-w-0 overflow-hidden border-amber-200">
        <CardContent className="min-w-0 p-3 sm:p-4">
          <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words font-black text-[#0f2b46]">مراجعة التصحيح — حسب الطالب</h3><Badge>{groups.length} طالب · {attempts.length} محاولة</Badge></div>
          <select value={statusFilter} onChange={(e) => { setSelected(null); setStatusFilter(e.target.value as any) }} className="mb-3 w-full rounded-xl border bg-white p-2 text-xs font-bold text-[#0f2b46]">
            <option value="NEEDS_REVIEW">قيد المراجعة</option>
            <option value="GRADED">مصححة/مجتازة</option>
            <option value="ALL">الكل</option>
          </select>
          {allApprovable.length > 0 && (
            <Button onClick={() => void runBulk('ALL', attempts)} disabled={bulkBusy !== null} className="mb-2 w-full bg-emerald-600 font-black text-white hover:bg-emerald-700 disabled:opacity-50">
              <ShieldCheck className="ml-1 h-4 w-4" />
              {bulkBusy === 'ALL' ? 'جارٍ التنفيذ...' : armBulk === 'ALL' ? `تأكيد مصادقة ${allApprovable.length} درجة نهائية غير مصادقة؟` : `مصادقة كل الدرجات النهائية غير المصادقة (${allApprovable.length})`}
            </Button>
          )}
          {bulkReport && <p className="mb-2 rounded-xl bg-emerald-50 p-2 text-[11px] font-bold leading-5 text-emerald-800">{bulkReport}</p>}
          {loading ? <p className="text-sm text-slate-500">جاري التحميل...</p> : attempts.length === 0 ? <p className="text-sm font-bold text-emerald-700">لا توجد محاولات ضمن هذا الفلتر.</p> : (
            <div className="space-y-2">
              {groups.map((g, gi) => {
                const unapproved = g.items.filter(isApprovable).length
                const isOpen = isExpanded(g.key, gi)
                return (
                  <div key={g.key} className="overflow-hidden rounded-xl border bg-white">
                    <div className="flex w-full min-w-0 flex-col items-stretch gap-2 p-3 sm:flex-row sm:items-center">
                      <button type="button" onClick={() => toggleStudent(g.key, gi)} className="flex min-w-0 flex-1 items-center gap-2 text-right hover:opacity-80">
                        {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronLeft className="h-4 w-4 shrink-0 text-slate-400" />}
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-black text-[#0f2b46]">{g.name}</span>
                          <span className="block truncate text-[10px] text-slate-400">{g.email} · {g.items.length} محاولة{unapproved > 0 ? ` · ${unapproved} بلا مصادقة` : ' · كل درجاته مصادقة'}</span>
                        </span>
                      </button>
                      {unapproved > 0 && (
                        <Button size="sm" onClick={() => void runBulk(g.key, g.items)} disabled={bulkBusy !== null} className="shrink-0 bg-emerald-600 text-[10px] font-black text-white hover:bg-emerald-700 disabled:opacity-50">
                          {bulkBusy === g.key ? 'جارٍ...' : armBulk === g.key ? `تأكيد (${unapproved})؟` : `مصادقة الكل (${unapproved})`}
                        </Button>
                      )}
                    </div>
                    {isOpen && (
                      <div className="space-y-1 border-t bg-slate-50/60 p-2">
                        {g.items.map((a) => (
                          <button key={`${a.type}:${a.id}`} onClick={() => open(a)} className="w-full rounded-lg border bg-white p-2.5 text-right text-xs hover:bg-amber-50">
                            <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                              <span className="min-w-0 break-words font-black text-[#0f2b46]">{a.exam.title}</span>
                              <ApprovalBadge state={a.approvalState} />
                            </span>
                            <span className="mt-0.5 block text-slate-400">
                              {a.type === 'UNIT' ? 'اختبار وحدة' : 'امتحان برنامج'} · {a.status === 'GRADED' ? `مصححة${a.score != null ? ` — الدرجة ${a.score}` : ''}` : a.status === 'SUBMITTED' ? 'عالقة قيد التصحيح' : 'قيد المراجعة'} · {new Date(a.submittedAt).toLocaleString('ar')}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="w-full min-w-0 overflow-hidden">
        <CardContent className="min-w-0 p-3 sm:p-4">
          {!selected ? <p className="text-sm font-bold text-slate-500">اختر طالبًا ثم محاولة لعرض كل الأسئلة وإقرار النتيجة.</p> : <div className="space-y-4">
            {selected.status === 'NEEDS_REVIEW' ? <div className="flex flex-wrap gap-2"><Button onClick={regrade} variant="outline" disabled={busy !== null}>{busy === 'regrade' ? 'جارٍ التصحيح...' : 'إعادة التصحيح الآلي'}</Button><Button onClick={approve} disabled={busy !== null} className="bg-[#0f2b46] text-[#f5f0e1]">{busy === 'approve' ? 'جارٍ الاعتماد...' : 'اعتماد النتيجة'}</Button></div> : selected.status === 'SUBMITTED' ? <div className="flex flex-wrap items-center gap-2"><Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">محاولة عالقة قيد التصحيح</Badge><Button onClick={markReview} disabled={busy !== null} variant="outline">{busy === 'regrade' ? 'جارٍ النقل...' : 'نقل إلى المراجعة'}</Button></div> : <div className="flex flex-wrap items-center gap-2"><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">محاولة مصححة</Badge><Button onClick={approveOfficial} disabled={busy !== null} className="bg-emerald-600 font-black text-white hover:bg-emerald-700">{busy === 'approve-grade' ? 'جارٍ المصادقة...' : 'مصادقة الدرجة رسميًا'}</Button></div>}
            {selected.answers.map((a) => <div key={a.answerId} className="min-w-0 break-words rounded-2xl border p-3 text-sm [overflow-wrap:anywhere]">
              <p className="font-black text-[#0f2b46]">سؤال {a.order} ({a.questionType === 'MCQ' ? 'اختيار من متعدد' : a.questionType === 'TF' ? 'صح/خطأ' : a.questionType === 'SHORT' ? 'إجابة قصيرة' : 'مقالي'}): {a.question}</p>
              <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-2"><b>إجابة الطالب:</b> {a.studentAnswer || '—'}</p>
              <p className="mt-2 whitespace-pre-wrap rounded-xl bg-emerald-50 p-2"><b>الإجابة النموذجية:</b> {a.modelAnswer || '—'}</p>
              {a.source && <p className="mt-2 whitespace-pre-wrap rounded-xl bg-amber-50 p-2"><b>المصدر:</b> {a.source}</p>}
              {a.aiFeedback && <p className="mt-2 whitespace-pre-wrap rounded-xl bg-blue-50 p-2"><b>نتيجة AI:</b> {a.aiFeedback}</p>}
              <label className="mt-3 block text-xs font-black">النقاط من {a.maxPoints}</label>
              <Input value={scores[a.answerId] || ''} onChange={(e) => setScores((prev) => ({ ...prev, [a.answerId]: e.target.value }))} />
            </div>)}
          </div>}
        </CardContent>
      </Card>
    </div>
  )
}
