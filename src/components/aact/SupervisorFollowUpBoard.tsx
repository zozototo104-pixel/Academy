'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FollowUpDutyChips, FollowUpRecordView, absenceLabel, type FollowUpBoardRow } from '@/components/aact/FollowUpShared'

// متابعة الطلاب عند المشرف البشري (خدمة المتابعة): نفس لوحة الواجبات
// والغياب التي تراها الإدارة، لكن لطلابه فقط (النطاق مضبوط في الـ API).
// «فتح بطاقة الطالب» يختار الطالب في بطاقته بالأسفل حيث تبويب محادثته.
export function SupervisorFollowUpBoard({ onOpenStudent }: { onOpenStudent: (admissionId: string) => void }) {
  const [rows, setRows] = useState<FollowUpBoardRow[]>([])
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const d = await api<{ students: FollowUpBoardRow[] }>('/api/supervisor/student-follow-up')
        setRows(d.students || [])
      } catch {
        setRows([])
      }
    })()
  }, [])

  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => {
    if (a.needsIntervention !== b.needsIntervention) return a.needsIntervention ? -1 : 1
    return b.daysAbsent - a.daysAbsent
  })

  return (
    <Card className="mb-5 border-[#c9a227]/40" dir="rtl">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-black text-[#0f2b46]">متابعة طلابي — الواجبات والغياب</h2>
          <Badge className="bg-red-100 text-red-700">يحتاج تدخل {rows.filter((r) => r.needsIntervention).length}</Badge>
          <Badge className="bg-amber-100 text-amber-700">غائب 3 أيام+ {rows.filter((r) => r.daysAbsent >= 3 && !r.needsIntervention).length}</Badge>
        </div>
        <div className="space-y-2.5">
          {sorted.map((row) => (
            <div key={row.enrollmentId} className={`space-y-2 rounded-2xl border p-3 ${row.needsIntervention ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-black text-[#0f2b46]">{row.name}</span>
                <span className="text-[11px] text-slate-500">{row.specialization}</span>
                {row.needsIntervention && <Badge className="bg-red-600 text-white">يحتاج تدخل</Badge>}
                <Badge variant="outline" className="text-[10px]">{absenceLabel(row)}</Badge>
                <Badge variant="outline" className="text-[10px]">رسائل متابعة: {row.followUpsSent}/3</Badge>
                <span className="mr-auto flex gap-1.5">
                  <Button size="sm" variant="outline" className="text-[11px] font-bold" onClick={() => setExpandedUserId(expandedUserId === row.userId ? null : row.userId)}>
                    {expandedUserId === row.userId ? 'إخفاء السجل' : 'سجل المتابعات'}
                  </Button>
                  {row.admissionId && (
                    <Button size="sm" className="bg-[#0f2b46] text-[11px] font-bold hover:bg-[#0f2b46]/90" onClick={() => onOpenStudent(row.admissionId!)}>
                      فتح بطاقة الطالب
                    </Button>
                  )}
                </span>
              </div>
              <FollowUpDutyChips row={row} />
              {expandedUserId === row.userId && <FollowUpRecordView apiBase="/api/supervisor/student-follow-up" userId={row.userId} />}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
