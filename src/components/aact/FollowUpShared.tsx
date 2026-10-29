'use client'

import { useState } from 'react'
import { api } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// عناصر مشتركة بين لوحة متابعة الأدمن ولوحة متابعة المشرف (خدمة المتابعة):
// صف اللوحة كما يصله الـ API، مؤشرات الواجبات، وعرض سجل متابعات الطالب.

export type FollowUpBoardRow = {
  userId: string
  enrollmentId: string
  admissionId: string | null
  name: string
  email: string
  programId: string
  programTitle: string
  specialization: string
  lastActivityAt: string | null
  daysAbsent: number
  followUpCount: number
  needsIntervention: boolean
  followUpsSent: number
  platformMessages: number
  unreadPlatformMessages: number
  assignments: { total: number; submitted: number }
  unitExams: { total: number; passed: number }
  lectures: { total: number; watched: number; completed: number }
  supervisorInteraction: { count: number; lastAt: string | null }
}

export type FollowUpRecord = {
  logs: Array<{
    id: string
    kind: string
    messageIndex: number
    daysAbsent: number
    platformSent: boolean
    emailSent: boolean
    whatsappStatus: string
    title: string | null
    createdAt: string
  }>
  notifications: Array<{ id: string; type: string; title: string; read: boolean; createdAt: string }>
  adminMessages: { count: number; lastAt: string | null }
}

export function dateAr(v: string | null | undefined) {
  if (!v) return '—'
  try { return new Date(v).toLocaleString('ar-EG') } catch { return '' }
}

export function absenceLabel(row: FollowUpBoardRow) {
  if (!row.lastActivityAt) return 'لا نشاط مسجل بعد'
  if (row.daysAbsent <= 0) return 'نشط اليوم'
  if (row.daysAbsent === 1) return 'آخر نشاط أمس'
  return `غائب منذ ${row.daysAbsent} أيام`
}

function dutyChip(label: string, done: number, total: number, okWhenNoTotal = true) {
  const doneAll = total === 0 ? okWhenNoTotal : done >= total
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${doneAll ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
      {label}: {done}/{total}
    </span>
  )
}

export function FollowUpDutyChips({ row }: { row: FollowUpBoardRow }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {dutyChip('الواجبات', row.assignments.submitted, row.assignments.total)}
      {dutyChip('اختبارات الوحدات', row.unitExams.passed, row.unitExams.total)}
      {dutyChip('المحاضرات المكتملة', row.lectures.completed, row.lectures.total)}
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
        بدأ مشاهدة {row.lectures.watched} محاضرة
      </span>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${row.supervisorInteraction.count > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
        تفاعل المشرف: {row.supervisorInteraction.count > 0 ? `${row.supervisorInteraction.count} رسالة` : 'لا يوجد'}
      </span>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${row.unreadPlatformMessages > 0 ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'}`}>
        رسائل المنصة: {row.platformMessages}{row.unreadPlatformMessages > 0 ? ` (${row.unreadPlatformMessages} غير مقروءة)` : ''}
      </span>
    </div>
  )
}

const WHATSAPP_LABEL: Record<string, string> = { TEXT: 'نص واتساب', TEMPLATE: 'قالب واتساب', FAILED: 'واتساب فشل', SKIPPED: 'واتساب متخطى' }

export function FollowUpRecordView({ apiBase, userId }: { apiBase: string; userId: string }) {
  const [record, setRecord] = useState<FollowUpRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const d = await api<{ record: FollowUpRecord }>(`${apiBase}?userId=${encodeURIComponent(userId)}`)
      setRecord(d.record)
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل السجل')
    } finally {
      setLoading(false)
    }
  }

  if (!record && !loading && !error) {
    return (
      <Button size="sm" variant="outline" onClick={load} className="text-[11px] font-bold">
        تحميل سجل المتابعات
      </Button>
    )
  }
  if (loading) return <p className="text-[11px] font-bold text-slate-500">جارٍ تحميل السجل…</p>
  if (error) return <p className="text-[11px] font-bold text-red-600">{error}</p>
  if (!record) return null

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
      <div>
        <p className="mb-1.5 text-[11px] font-black text-[#0f2b46]">سجل رسائل المتابعة</p>
        {record.logs.length === 0 && <p className="text-[11px] text-slate-500">لا رسائل متابعة مرسلة لهذا الطالب بعد.</p>}
        <div className="space-y-1.5">
          {record.logs.map((log) => (
            <div key={log.id} className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white px-2.5 py-1.5 text-[11px] shadow-sm">
              {log.kind === 'RETURNED' ? (
                <span className="font-bold text-emerald-700">رجع للمنصة</span>
              ) : (
                <>
                  <span className="font-bold text-[#0f2b46]">رسالة متابعة #{log.messageIndex}</span>
                  <span className="text-slate-500">غياب {log.daysAbsent} أيام</span>
                  <Badge variant="outline" className="text-[9px]">منصة {log.platformSent ? '✓' : '—'}</Badge>
                  <Badge variant="outline" className="text-[9px]">إيميل {log.emailSent ? '✓' : '—'}</Badge>
                  <Badge variant="outline" className="text-[9px]">{WHATSAPP_LABEL[log.whatsappStatus] || log.whatsappStatus}</Badge>
                </>
              )}
              <span className="mr-auto text-[10px] text-slate-400">{dateAr(log.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-black text-[#0f2b46]">آخر رسائل المنصة</p>
        {record.notifications.length === 0 && <p className="text-[11px] text-slate-500">لا رسائل منصة.</p>}
        <div className="space-y-1">
          {record.notifications.slice(0, 10).map((n) => (
            <div key={n.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className={n.read ? 'text-slate-500' : 'font-bold text-[#0f2b46]'}>{n.title}</span>
              <Badge className={`text-[9px] ${n.read ? 'bg-slate-200 text-slate-600' : 'bg-sky-100 text-sky-700'}`}>{n.read ? 'مقروء' : 'غير مقروء'}</Badge>
              <span className="text-[10px] text-slate-400">{dateAr(n.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-slate-600">
        رسائل الإدارة المباشرة: {record.adminMessages.count > 0 ? `${record.adminMessages.count} رسالة — آخرها ${dateAr(record.adminMessages.lastAt)}` : 'لا يوجد'}
      </p>
    </div>
  )
}
