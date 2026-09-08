'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AcademyLogo } from '@/components/aact/Shell'
import { Printer, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/store'

export interface CertificateData {
  serial: string
  type: string
  holderName: string
  program: string
  grade?: string | null
  country?: string | null
  issuedAt: string
}

const TYPE_LABEL: Record<string, string> = {
  PROGRAM_COMPLETION: 'شهادة إتمام برنامج تدريبي',
  ACCREDITATION: 'شهادة اعتماد دولي',
  AGENCY: 'شهادة وكالة وتمثيل دولي',
}

// نافذة الشهادة الرقمية بقالب رسمي + QR للتحقق + طباعة PDF
export function CertificateDialog({
  certificate,
  open,
  onClose,
}: {
  certificate: CertificateData | null
  open: boolean
  onClose: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    if (!certificate || !open) return
    const verifyUrl = `${window.location.origin}/?view=verify&serial=${certificate.serial}`
    api<{ qr: string }>(`/api/certificates/qr?data=${encodeURIComponent(verifyUrl)}`)
      .then((d) => setQr(d.qr))
      .catch(() => setQr(null))
  }, [certificate, open])

  if (!certificate) return null
  const date = new Date(certificate.issuedAt).toLocaleDateString('ar-EG', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto p-0 sm:p-0" dir="rtl" aria-describedby={undefined}>
        <DialogTitle className="sr-only">شهادة رقمية رسمية — {certificate.holderName}</DialogTitle>
        <DialogDescription className="sr-only">
          {TYPE_LABEL[certificate.type] || 'شهادة رسمية'} برقم {certificate.serial}
        </DialogDescription>
        {/* قالب الشهادة الرسمي */}
        <div id="aact-certificate" className="relative overflow-hidden bg-[#fffdf5] p-6 sm:p-10">
          {/* إطار مزدوج */}
          <div className="pointer-events-none absolute inset-3 rounded-lg border-4 border-[#c9a227]" />
          <div className="pointer-events-none absolute inset-5 rounded border border-[#0f2b46]/40" />

          <div className="relative px-2 pb-4 pt-6 text-center sm:px-8">
            {/* الشعار */}
            <div className="flex justify-center">
              <AcademyLogo size={84} />
            </div>

            <p className="mt-3 text-xs font-bold tracking-wide text-[#a8841a]">
              AMERICAN ACADEMY FOR CONSULTING AND TRAINING
            </p>
            <h1 className="mt-1 text-lg font-black text-[#0f2b46] sm:text-xl">
              الأكاديمية الأمريكية للاستشارات والتدريب
            </h1>

            <div className="mx-auto mt-4 h-px w-40 bg-gradient-to-l from-transparent via-[#c9a227] to-transparent" />

            <h2 className="mt-5 text-base font-black text-[#b22234] sm:text-lg">
              {TYPE_LABEL[certificate.type] || 'شهادة رسمية'}
            </h2>

            <p className="mt-4 text-sm text-slate-600">تشهد الأكاديمية بأن</p>
            <p className="mt-2 border-b-2 border-[#c9a227]/60 pb-1 text-2xl font-black text-[#0f2b46] sm:text-3xl">
              {certificate.holderName}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              قد أتمّ بنجاح متطلبات
            </p>
            <p className="mt-1.5 px-4 text-lg font-extrabold leading-relaxed text-[#a8841a]">
              {certificate.program}
            </p>

            {certificate.grade && (
              <p className="mt-2 text-sm font-bold text-slate-600">
                النتيجة / التقدير: <span className="text-[#0f2b46]">{certificate.grade}</span>
              </p>
            )}

            <p className="mx-auto mt-4 max-w-lg text-[11px] leading-relaxed text-slate-500">
              شهادة معادلة خبرات تدريبية مهنية وفق لوائح الأكاديمية، وتُصدر خلال 30 يوماً من استلام
              كشوف الدرجات والرسوم المقررة — ويمكن التحقق من صحتها فوراً عبر رمز QR أو صفحة التحقق الرسمية.
            </p>

            {/* التوقيعات والQR */}
            <div className="mt-8 grid grid-cols-3 items-end gap-3">
              <div className="text-center">
                <div className="mx-auto mb-1 h-10 w-28 border-b-2 border-[#0f2b46]/50" />
                <p className="text-[10px] font-black text-[#0f2b46]">رئيس مجلس الإدارة</p>
                <p className="text-[9px] text-slate-400">Chairman of the Board</p>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                {qr && <img src={qr} alt="رمز التحقق QR" className="h-24 w-24 rounded border border-slate-200 bg-white p-1" />}
                <p className="font-mono text-[10px] font-bold text-[#0f2b46]" dir="ltr">{certificate.serial}</p>
              </div>
              <div className="text-center">
                <div className="mx-auto mb-1 h-10 w-28 border-b-2 border-[#0f2b46]/50" />
                <p className="text-[10px] font-black text-[#0f2b46]">المدير الأكاديمي</p>
                <p className="text-[9px] text-slate-400">Academic Director</p>
              </div>
            </div>

            <p className="mt-5 text-[10px] text-slate-400">
              تاريخ الإصدار: {date} {certificate.country ? `— ${certificate.country}` : ''}
            </p>
          </div>
        </div>

        {/* أزرار */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-white px-4 py-3">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
            <ShieldCheck className="h-4 w-4" /> تحقق فوري عبر صفحة «تحقق من شهادة» برقم الشهادة
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => window.print()}
              className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
            >
              <Printer className="ml-1.5 h-4 w-4" /> طباعة / حفظ PDF
            </Button>
            <Button variant="outline" onClick={onClose} className="border-[#0f2b46]/20 font-bold text-[#0f2b46]">
              إغلاق
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
