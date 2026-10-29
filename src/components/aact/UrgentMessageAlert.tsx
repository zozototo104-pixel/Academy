'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useAppStore } from '@/lib/store'

type UrgentData = {
  admin: { count: number; latestAt: string | null; admissionId: string | null }
  supervisor: { count: number; latestAt: string | null }
}

const EMPTY: UrgentData = { admin: { count: 0, latestAt: null, admissionId: null }, supervisor: { count: 0, latestAt: null } }

// تنبيه «الخبر العاجل» للطالب: شريط أحمر نابض + نغمة «طوط طوط» متكررة ما دام
// عنده رسائل غير مقروءة من الإدارة أو من مشرفه البشري. «فتح الرسالة» يعلّم
// النوع مقروءًا ويقفز لمحادثته؛ الإغلاق يخفي الشريط لهذه الجلسة فقط — إن بقيت
// الرسائل غير مقروءة يعود الشريط مع فتح المنصة من جديد.
// الصوت: المتصفحات تمنع التشغيل قبل أول تفاعل، فيُستأنف سياق الصوت مع أول
// لمسة؛ الشريط البصري يظهر فورًا في كل الأحوال.
export function UrgentMessageAlert() {
  const { user, navigate } = useAppStore()
  const [data, setData] = useState<UrgentData>(EMPTY)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const audioRef = useRef<AudioContext | null>(null)

  const isStudent = user?.role === 'STUDENT'
  const total = data.admin.count + data.supervisor.count
  const currentKey = `${data.admin.latestAt || ''}|${data.supervisor.latestAt || ''}`
  const visible = isStudent && total > 0 && dismissedKey !== currentKey

  const load = useCallback(() => {
    if (!isStudent) return
    api<UrgentData>('/api/student/urgent-messages')
      .then((d) => setData({ admin: { ...EMPTY.admin, ...(d.admin || {}) }, supervisor: { ...EMPTY.supervisor, ...(d.supervisor || {}) } }))
      .catch(() => {})
  }, [isStudent])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  // نغمة طوط طوط: نبضتان قصيرتان كل 2.8 ثانية ما دام الشريط ظاهرًا.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const ensureCtx = () => {
      try {
        const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
        if (!AudioCtx) return null
        let ctx: AudioContext | null = audioRef.current
        if (!ctx) {
          ctx = new AudioCtx() as AudioContext
          audioRef.current = ctx
        }
        if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
        return ctx
      } catch { return null }
    }
    const twoBeeps = () => {
      const ctx = ensureCtx()
      if (!ctx || cancelled) return
      try {
        const start = ctx.currentTime
        ;[0, 0.3].forEach((offset) => {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.value = 880
          gain.gain.value = 0.07
          osc.connect(gain)
          gain.connect(ctx.destination)
          osc.start(start + offset)
          osc.stop(start + offset + 0.16)
        })
      } catch { /* الصوت اختياري — الشريط البصري هو الأساس */ }
    }
    twoBeeps()
    const t = setInterval(() => { if (document.visibilityState === 'visible') twoBeeps() }, 2800)
    const unlock = () => { ensureCtx() }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      cancelled = true
      clearInterval(t)
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [visible])

  if (!visible) return null

  const markRead = (kind: 'ADMIN' | 'SUPERVISION') =>
    api('/api/student/urgent-messages', { method: 'POST', body: JSON.stringify({ kind }) }).catch(() => {})

  const openDashboardTab = (tab: string, admissionId?: string | null) => {
    navigate('dashboard')
    ;[80, 300, 700, 1200].forEach((delay) => {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('aact:dashboard-tab', { detail: { tab, admissionId: admissionId || null } })), delay)
    })
  }

  const openAdmin = async () => {
    const admissionId = data.admin.admissionId
    await markRead('ADMIN')
    setData((prev) => ({ ...prev, admin: { ...EMPTY.admin } }))
    openDashboardTab('messages', admissionId)
  }

  const openSupervisor = async () => {
    await markRead('SUPERVISION')
    setData((prev) => ({ ...prev, supervisor: { ...EMPTY.supervisor } }))
    openDashboardTab('supervision')
  }

  return (
    <div dir="rtl" className="fixed inset-x-0 top-0 z-[120] flex justify-center px-2 pt-2 sm:px-4">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border-2 border-red-300 bg-gradient-to-l from-red-700 via-red-600 to-red-700 shadow-2xl shadow-red-900/40 animate-pulse">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-80" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-white" />
          </span>
          <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-black tracking-wide text-red-700">عاجل</span>
          <div className="min-w-0 flex-1 text-[13px] font-black leading-6 text-white sm:text-sm">
            {data.admin.count > 0 && <p>رسالة عاجلة من الإدارة — {data.admin.count} غير مقروءة</p>}
            {data.supervisor.count > 0 && <p>رسالة عاجلة من مشرفك الأكاديمي — {data.supervisor.count} غير مقروءة</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {data.admin.count > 0 && (
              <button type="button" onClick={openAdmin} className="rounded-xl bg-white px-3 py-1.5 text-[11px] font-black text-red-700 shadow hover:bg-red-50">
                فتح رسالة الإدارة
              </button>
            )}
            {data.supervisor.count > 0 && (
              <button type="button" onClick={openSupervisor} className="rounded-xl bg-white px-3 py-1.5 text-[11px] font-black text-red-700 shadow hover:bg-red-50">
                فتح رسالة المشرف
              </button>
            )}
            <button type="button" aria-label="إغلاق التنبيه" onClick={() => setDismissedKey(currentKey)} className="rounded-xl bg-red-800/70 px-2.5 py-1.5 text-[11px] font-black text-white hover:bg-red-800">
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
