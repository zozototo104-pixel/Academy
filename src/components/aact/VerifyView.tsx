'use client'

import { useEffect, useState } from 'react'
import { useAppStore, api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import { ShieldCheck, Search, Loader2, BadgeCheck, XCircle, Eye } from 'lucide-react'

interface VerifyResult {
  valid: boolean
  certificate?: CertificateData & {
    valid: boolean
    academicProfile?: {
      academicTitle: string
      durationLabel: string
      creditHoursLabel: string
      learningOutcomes: string[]
      qualityControls: string[]
      termPlans?: { id: string; title: string; weight: number; requiredBooks: { title: string }[]; finalEvaluation: string }[]
      finalEvaluationFormula?: { label: string; weight: number; description: string }[]
    } | null
  }
  message: string
}

export function VerifyView() {
  const { navigate } = useAppStore()
  const [serial, setSerial] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [showCert, setShowCert] = useState(false)

  const verify = async (value?: string) => {
    const s = (value ?? serial).trim()
    if (!s) return
    setLoading(true)
    setResult(null)
    try {
      const d = await api<VerifyResult>(`/api/certificates/verify?serial=${encodeURIComponent(s)}`)
      setResult(d)
    } catch (e: any) {
      setResult({ valid: false, message: e.message })
    } finally {
      setLoading(false)
    }
  }

  // دعم فتح الرابط مباشرة من QR (?view=verify&serial=...)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const s = q.get('serial')
    if (s) {
      setSerial(s)
      verify(s)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="aact-fade-in mx-auto max-w-3xl px-4 py-12">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-[#0f2b46] p-4 text-[#e0b83a]">
          <ShieldCheck className="h-9 w-9" />
        </div>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">التحقق من صحة الشهادات</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-600">
          صفحة التحقق الرسمية من شهادات الأكاديمية الأمريكية للاستشارات والتدريب. أدخل الرقم
          التسلسلي المدون أسفل الشهادة (مثال: AACT-C-2026-00001) للاطمئنان على صحتها فوراً —
          وهو نفس الرمز المتاح في QR المطبوع على الشهادة.
        </p>
      </div>

      <Card className="border-[#0f2b46]/15 shadow-lg">
        <CardContent className="p-6 sm:p-8">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              verify()
            }}
            className="flex flex-col gap-3 sm:flex-row"
          >
            <Input
              dir="ltr"
              className="text-left font-mono text-sm"
              placeholder="AACT-C-2026-00001"
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              aria-label="رقم الشهادة"
            />
            <Button
              type="submit"
              disabled={loading}
              className="shrink-0 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
            >
              {loading ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Search className="ml-1 h-4 w-4" />}
              تحقق الآن
            </Button>
          </form>

          {result && (
            <div
              className={`mt-6 rounded-2xl border p-5 ${
                result.valid ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60'
              }`}
            >
              <div className="flex items-center gap-2">
                {result.valid ? (
                  <BadgeCheck className="h-6 w-6 text-emerald-600" />
                ) : (
                  <XCircle className="h-6 w-6 text-red-500" />
                )}
                <h3 className={`text-base font-black ${result.valid ? 'text-emerald-700' : 'text-red-600'}`}>
                  {result.valid ? 'الشهادة صحيحة وموثقة' : 'نتيجة التحقق'}
                </h3>
              </div>
              <p className={`mt-2 text-sm font-bold ${result.valid ? 'text-emerald-800' : 'text-red-700'}`}>
                {result.message}
              </p>
              {result.certificate && (
                <div className="mt-4 grid gap-3 rounded-xl bg-white/80 p-4 text-xs sm:grid-cols-2">
                  <div>
                    <span className="font-bold text-slate-400">صاحب الشهادة: </span>
                    <span className="font-black text-[#0f2b46]">{result.certificate.holderName}</span>
                  </div>
                  <div>
                    <span className="font-bold text-slate-400">الرقم التسلسلي: </span>
                    <span className="font-mono font-black text-[#0f2b46]" dir="ltr">{result.certificate.serial}</span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="font-bold text-slate-400">البرنامج / الاعتماد: </span>
                    <span className="font-bold text-[#a8841a]">{result.certificate.program}</span>
                  </div>
                  {result.certificate.grade && (
                    <div>
                      <span className="font-bold text-slate-400">النتيجة: </span>
                      <span className="font-bold text-[#0f2b46]">{result.certificate.grade}</span>
                    </div>
                  )}
                  <div>
                    <span className="font-bold text-slate-400">تاريخ الإصدار: </span>
                    <span className="font-bold text-[#0f2b46]">
                      {new Date(result.certificate.issuedAt).toLocaleDateString('ar-EG')}
                    </span>
                  </div>
                  {result.certificate.academicProfile && (
                    <div className="sm:col-span-2 rounded-xl border border-[#c9a227]/25 bg-[#fffaf0] p-3">
                      <p className="font-black text-[#0f2b46]">الملف الأكاديمي المرتبط بالشهادة</p>
                      <p className="mt-1 font-bold text-[#a8841a]">{result.certificate.academicProfile.academicTitle}</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">{result.certificate.academicProfile.durationLabel} · {result.certificate.academicProfile.creditHoursLabel}</p>
                      <ul className="mt-2 space-y-1 text-[11px] font-bold leading-5 text-slate-600">
                        {result.certificate.academicProfile.learningOutcomes.slice(0, 3).map((item, i) => <li key={i}>• {item}</li>)}
                      </ul>
                      {(result.certificate.academicProfile.termPlans?.length || 0) > 0 && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                          {result.certificate.academicProfile.termPlans!.slice(0, 3).map((term) => (
                            <div key={term.id} className="rounded-lg bg-white p-2 ring-1 ring-[#c9a227]/20">
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <p className="font-black text-[#0f2b46]">{term.title}</p>
                                <span className="rounded-full bg-[#f7edd0] px-1.5 py-0.5 font-black text-[#a8841a]">{term.weight}%</span>
                              </div>
                              <p>كتب: {term.requiredBooks.length ? term.requiredBooks.slice(0, 2).map((b) => b.title).join('، ') : 'وفق الخطة'}</p>
                              <p className="text-[#a8841a]">{term.finalEvaluation}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="sm:col-span-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowCert(true)}
                      className="border-[#c9a227] font-bold text-[#a8841a]"
                    >
                      <Eye className="ml-1 h-3.5 w-3.5" /> عرض الشهادة كاملة
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-400">
        شهادات الأكاديمية شهادات معادلة خبرات تدريبية مهنية وليست شهادات أكاديمية حكومية —
        لأي استفسار تواصل معنا عبر{' '}
        <button className="font-bold text-[#a8841a] hover:underline" onClick={() => navigate('contact')}>
          صفحة التواصل
        </button>
      </p>

      <CertificateDialog
        certificate={result?.valid && result.certificate ? result.certificate : null}
        open={showCert}
        onClose={() => setShowCert(false)}
      />
    </div>
  )
}
