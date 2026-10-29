'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { FollowUpDutyChips, FollowUpRecordView, absenceLabel, type FollowUpBoardRow } from '@/components/aact/FollowUpShared'

// متابعة الطلاب (خدمة المتابعة): لوحة واجبات كل طالب — دخل أو لا، رسائل
// المنصة وقراءتها، الواجبات، اختبارات الوحدات، المحاضرات، تفاعل المشرف —
// مع فلترة بالاسم والتخصص والحالة، وسجل متابعات لكل طالب، وزر مراسلة يقفز
// لمحادثة الإدارة معه.
export function AdminFollowUpTab({ onMessageStudent }: { onMessageStudent: (admissionId: string) => void }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<FollowUpBoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [specialization, setSpecialization] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'NEEDS' | 'ABSENT' | 'ACTIVE'>('ALL')
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const d = await api<{ students: FollowUpBoardRow[] }>('/api/admin/student-follow-up')
        setRows(d.students || [])
      } catch (e: any) {
        toast({ title: 'تعذر تحميل متابعة الطلاب', description: e?.message || 'حاول مرة أخرى', variant: 'destructive' })
      } finally {
        setLoading(false)
      }
    })()
  }, [toast])

  const specializations = useMemo(() => [...new Set(rows.map((r) => r.specialization).filter(Boolean))].sort(), [rows])
  const counts = useMemo(() => ({
    all: rows.length,
    needs: rows.filter((r) => r.needsIntervention).length,
    absent: rows.filter((r) => r.daysAbsent >= 3 && !r.needsIntervention).length,
  }), [rows])

  const filtered = useMemo(() => rows.filter((r) => {
    if (specialization !== 'ALL' && r.specialization !== specialization) return false
    if (statusFilter === 'NEEDS' && !r.needsIntervention) return false
    if (statusFilter === 'ABSENT' && !(r.daysAbsent >= 3 && !r.needsIntervention)) return false
    if (statusFilter === 'ACTIVE' && r.daysAbsent >= 3) return false
    const q = search.trim().toLowerCase()
    if (q && !`${r.name} ${r.email} ${r.programTitle}`.toLowerCase().includes(q)) return false
    return true
  }), [rows, search, specialization, statusFilter])

  // «يحتاج تدخل» أولاً، ثم الأطول غيابًا — من يحتاج العين يظهر أولاً.
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    if (a.needsIntervention !== b.needsIntervention) return a.needsIntervention ? -1 : 1
    return b.daysAbsent - a.daysAbsent
  }), [filtered])

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-black text-[#0f2b46]">متابعة الطلاب</h3>
        <Badge className="bg-slate-100 text-slate-700">الكل {counts.all}</Badge>
        <Badge className="bg-red-100 text-red-700">يحتاج تدخل {counts.needs}</Badge>
        <Badge className="bg-amber-100 text-amber-700">غائب 3 أيام+ {counts.absent}</Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالاسم أو الإيميل أو البرنامج…" className="w-full max-w-xs text-xs" />
        <select value={specialization} onChange={(e) => setSpecialization(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-bold">
          <option value="ALL">كل التخصصات</option>
          {specializations.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-bold">
          <option value="ALL">كل الحالات</option>
          <option value="NEEDS">يحتاج تدخل</option>
          <option value="ABSENT">غائب</option>
          <option value="ACTIVE">نشط</option>
        </select>
      </div>

      {loading && <p className="text-xs font-bold text-slate-500">جارٍ تحميل اللوحة…</p>}
      {!loading && sorted.length === 0 && <p className="text-xs font-bold text-slate-500">لا طلاب مطابقين للفلترة.</p>}

      <div className="space-y-3">
        {sorted.map((row) => (
          <Card key={row.enrollmentId} className={row.needsIntervention ? 'border-red-200' : ''}>
            <CardContent className="space-y-2.5 p-4">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0">
                  <button type="button" onClick={() => setExpandedUserId(expandedUserId === row.userId ? null : row.userId)} className="text-right text-sm font-black text-[#0f2b46] underline-offset-4 hover:underline">
                    {row.name}
                  </button>
                  <p className="text-[11px] text-slate-500">{row.specialization} — {row.programTitle}</p>
                </div>
                <div className="mr-auto flex flex-wrap items-center gap-1.5">
                  {row.needsIntervention && <Badge className="bg-red-600 text-white">يحتاج تدخل</Badge>}
                  <Badge variant="outline" className="text-[10px]">{absenceLabel(row)}</Badge>
                  <Badge variant="outline" className="text-[10px]">رسائل متابعة: {row.followUpsSent}/3</Badge>
                </div>
              </div>
              <FollowUpDutyChips row={row} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="text-[11px] font-bold" onClick={() => setExpandedUserId(expandedUserId === row.userId ? null : row.userId)}>
                  {expandedUserId === row.userId ? 'إخفاء السجل' : 'سجل المتابعات'}
                </Button>
                {row.admissionId && (
                  <Button size="sm" className="bg-[#0f2b46] text-[11px] font-bold hover:bg-[#0f2b46]/90" onClick={() => onMessageStudent(row.admissionId!)}>
                    مراسلة الطالب
                  </Button>
                )}
              </div>
              {expandedUserId === row.userId && <FollowUpRecordView apiBase="/api/admin/student-follow-up" userId={row.userId} />}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
