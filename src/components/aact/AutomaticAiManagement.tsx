'use client'

import { useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

type Candidate = { provider: string; model: string; score: number; reason: string; measured: boolean; tier: string; capabilities: { contextLength?: number; vision?: boolean } }
type Snapshot = { enabled: boolean; checkedAt: string; note: string; transitions: Array<{ at: string; from: string; to: string }>; stages: Array<{ purpose: string; primary: Candidate | null; fallback: Candidate[]; excluded: Candidate[] }> }
const names: Record<string, string> = { CHAT: 'الشات والوكيل', ANALYSIS: 'تحليل المقاطع', VISION: 'قراءة الصور وإصلاح الصفحات', GENERATION: 'التوليد وبنك المعرفة', GRADING: 'التصحيح والتقييم', LONG_CONTEXT: 'المستندات الطويلة', REVIEW: 'التدقيق المستقل' }

export function AutomaticAiManagement({ enabled, onChange }: { enabled: boolean; onChange: (value: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function load(refresh = false) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (refresh) {
        const result = await api<{ refreshed: boolean; reason?: string }>('/api/admin/ai-automatic', { method: 'POST' })
        setMessage(result.refreshed ? 'تم تحديث الكتالوج.' : result.reason === 'disabled' ? 'احفظ تفعيل الوضع أولاً.' : 'الكتالوج حديث أو يجري تحديثه؛ الحد الدوري مرة كل ٦ ساعات.')
      }
      setSnapshot(await api<Snapshot>('/api/admin/ai-automatic'))
    } catch (error) {
      setError(error instanceof Error ? error.message : 'تعذر تحميل القرارات')
    } finally { setBusy(false) }
  }
  return <section dir="rtl" aria-label="الإدارة الذكية التلقائية" className="min-w-0 rounded-xl border border-indigo-200 bg-white p-4 space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-indigo-950">الإدارة الذكية التلقائية للمزودين والنماذج</h3>
        <p className="text-xs leading-6 text-slate-700">اختيار حسب المهمة والقدرات والنتائج الفعلية، مع حفظ الإعدادات اليدوية للعودة إليها. يسري المفتاح بعد حفظ إعدادات النظام.</p>
      </div>
      <Switch aria-label="تفعيل الإدارة الذكية التلقائية" checked={enabled} onCheckedChange={onChange} />
    </div>
    <p className="text-xs leading-6 text-slate-700">{enabled ? 'التفضيلات اليدوية وبروفايلات المراحل لا تتحكم بالتوجيه أثناء التفعيل؛ تبقى قيود الأمان والميزانية واستقلال المدقق فعالة.' : 'الوضع اليدوي: تبقى التفضيلات والبروفايلات الحالية فعالة.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => load()}>عرض قرارات التوجيه</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => load(true)}>تحديث الكتالوج</Button>
    </div>
    <div role="status" aria-live="polite" className="text-xs text-slate-700">{busy ? 'جارٍ تحميل المرشحين…' : message}</div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {snapshot && <>
      <p className="text-xs leading-6 text-slate-700">{snapshot.note}</p>
      <p className="text-xs text-slate-600">الوضع المحفوظ: {snapshot.enabled ? 'تلقائي' : 'يدوي'} · وقت الحساب: {new Date(snapshot.checkedAt).toLocaleString('ar')}</p>
      <details className="text-xs text-slate-700">
        <summary className="cursor-pointer py-1">سجل الانتقالات ({snapshot.transitions.length})</summary>
        {snapshot.transitions.map((item, index) => <p key={`${item.at}-${index}`} className="py-1">{new Date(item.at).toLocaleString('ar')} · من {item.from} إلى {item.to}</p>)}
        {!snapshot.transitions.length && <p>لا توجد انتقالات مسجلة بعد؛ يُسجل هنا كل تغيير بين الوضع التلقائي واليدوي.</p>}
      </details>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {snapshot.stages.map(stage => <article key={stage.purpose} className="min-w-0 rounded-lg border border-slate-200 p-3 space-y-2">
          <h4 className="text-sm font-bold text-slate-900">{names[stage.purpose]}</h4>
          {stage.primary ? <>
            <p dir="ltr" className="break-all text-sm font-semibold text-indigo-800">{stage.primary.provider} / {stage.primary.model}</p>
            <p className="text-xs text-slate-700">الدرجة: {stage.primary.score}/100 · {stage.primary.measured ? 'بقياسات استخدام' : 'غير مجرّب'} · التكلفة: {stage.primary.tier === 'FREE' ? 'مصنّف مجانيًا' : stage.primary.tier === 'PAID' ? 'مدفوع' : 'غير معروفة'}</p>
            <p className="text-xs leading-6 text-slate-700">{stage.primary.reason}</p>
            <p className="text-xs text-slate-600">السياق: {stage.primary.capabilities.contextLength?.toLocaleString('ar') || 'غير معروف'} · الصور: {stage.primary.capabilities.vision ? 'مدعومة حسب الكتالوج' : 'غير مثبتة بالكتالوج'}</p>
          </> : <p className="text-sm text-amber-800">لا يوجد مرشح مؤهل ضمن القيود الحالية.</p>}
          <details className="text-xs text-slate-700">
            <summary className="cursor-pointer py-2">البدائل والاستبعادات</summary>
            {stage.fallback.map(item => <p key={`${item.provider}/${item.model}`} className="break-words py-1">بديل: <bdi>{item.provider}/{item.model}</bdi> · {item.score}/100 · {item.reason}</p>)}
            {stage.excluded.map(item => <p key={`${item.provider}/${item.model}`} className="break-words py-1">مستبعد: <bdi>{item.provider}/{item.model}</bdi> — {item.reason}</p>)}
            {!stage.fallback.length && !stage.excluded.length && <p>لا توجد عناصر إضافية.</p>}
          </details>
        </article>)}
      </div>
    </>}
  </section>
}
