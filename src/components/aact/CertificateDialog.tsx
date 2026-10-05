'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AcademyLogo } from '@/components/aact/Shell'
import { FileText, Printer, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/store'

export interface CertificateData {
  serial: string
  qrToken?: string | null
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

const DEFAULT_TEMPLATE_LAYOUT: any = {
  holderName: { x: 50, y: 38, width: 72, fontSize: 4.8, align: 'center', color: '#0f2b46', visible: true },
  program: { x: 50, y: 52, width: 76, fontSize: 2.6, align: 'center', color: '#a8841a', visible: true },
  grade: { x: 50, y: 64, width: 44, fontSize: 1.7, align: 'center', color: '#0f2b46', visible: true },
  serial: { x: 84, y: 90, width: 22, fontSize: 1.2, align: 'right', color: '#0f2b46', visible: true },
  issuedAt: { x: 16, y: 90, width: 24, fontSize: 1.2, align: 'left', color: '#0f2b46', visible: true },
  qr: { x: 50, y: 86, size: 12, visible: true },
}

function layoutOf(raw: any) {
  return { ...DEFAULT_TEMPLATE_LAYOUT, ...(raw && typeof raw === 'object' ? raw : {}) }
}

function fieldStyle(field: any) {
  return {
    position: 'absolute' as const,
    left: `${Number(field?.x ?? 50)}%`,
    top: `${Number(field?.y ?? 50)}%`,
    width: `${Number(field?.width ?? 50)}%`,
    transform: 'translate(-50%, -50%)',
    textAlign: field?.align || 'center',
    color: field?.color || '#0f2b46',
    fontSize: `clamp(10px, ${Number(field?.fontSize ?? 2)}vw, 58px)`,
    fontWeight: 900,
    lineHeight: 1.25,
    whiteSpace: 'normal' as const,
  }
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
  const [template, setTemplate] = useState<{ id: string; name: string; imageUrl: string; layoutJson?: any } | null>(null)

  useEffect(() => {
    if (!certificate || !open) return
    const verifyUrl = certificate.qrToken
      ? `${window.location.origin}/verify/certificates/${encodeURIComponent(certificate.qrToken)}`
      : `${window.location.origin}/?view=verify&serial=${encodeURIComponent(certificate.serial)}`
    api<{ qr: string }>(`/api/certificates/qr?data=${encodeURIComponent(verifyUrl)}`)
      .then((d) => setQr(d.qr))
      .catch(() => setQr(null))
    api<{ template: { id: string; name: string; imageUrl: string } | null }>(`/api/certificates/templates/active?type=${encodeURIComponent(certificate.type)}`)
      .then((d) => setTemplate(d.template || null))
      .catch(() => setTemplate(null))
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
        <div id="aact-certificate" className={template ? 'relative aspect-[1.414/1] overflow-hidden bg-white' : 'relative overflow-hidden bg-[#fffdf5] p-6 sm:p-10'}>
          {template && (
            <>
              <img src={template.imageUrl} alt={template.name} className="absolute inset-0 h-full w-full object-cover" />
              <div className="absolute inset-0 text-center text-[#0f2b46]">
                <div className="absolute left-1/2 top-[38%] w-[72%] -translate-x-1/2 text-3xl font-black leading-tight sm:text-5xl">
                  {certificate.holderName}
                </div>
                <div className="absolute left-1/2 top-[52%] w-[76%] -translate-x-1/2 text-base font-extrabold leading-relaxed text-[#a8841a] sm:text-2xl">
                  {certificate.program}
                </div>
                {certificate.grade && <div className="absolute left-1/2 top-[64%] -translate-x-1/2 text-sm font-black sm:text-lg">{certificate.grade}</div>}
                <div className="absolute bottom-[9%] right-[9%] text-right font-mono text-[10px] font-black sm:text-sm" dir="ltr">{certificate.serial}</div>
                <div className="absolute bottom-[9%] left-[9%] text-left text-[10px] font-black sm:text-sm">{date}</div>
                {qr && <img src={qr} alt="رمز التحقق QR" className="absolute bottom-[9%] left-1/2 h-[14%] w-auto -translate-x-1/2 rounded bg-white p-1" />}
              </div>
            </>
          )}
          {/* إطار مزدوج */}
          <div className={template ? 'hidden' : 'pointer-events-none absolute inset-3 rounded-lg border-4 border-[#c9a227]'} />
          <div className={template ? 'hidden' : 'pointer-events-none absolute inset-5 rounded border border-[#0f2b46]/40'} />

          <div className={template ? 'hidden' : 'relative px-2 pb-4 pt-6 text-center sm:px-8'}>
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
            <ShieldCheck className="h-4 w-4" /> تحقق فوري عبر QR الآمن أو الرقم التسلسلي للشهادة
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline" className="border-emerald-200 font-bold text-emerald-700">
              <a href={`/api/verify/certificates/${encodeURIComponent(certificate.qrToken || certificate.serial)}`} target="_blank" rel="noreferrer">
                <ShieldCheck className="ml-1.5 h-4 w-4" /> JSON قابل للتحقق
              </a>
            </Button>
            <Button asChild variant="outline" className="border-[#c9a227]/40 font-bold text-[#a8841a]">
              <a href={`/api/pdf/certificates/${encodeURIComponent(certificate.qrToken || certificate.serial)}`} target="_blank" rel="noreferrer">
                <FileText className="ml-1.5 h-4 w-4" /> نسخة PDF رسمية
              </a>
            </Button>
            <Button
              onClick={() => window.print()}
              className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
            >
              <Printer className="ml-1.5 h-4 w-4" /> طباعة النافذة
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
