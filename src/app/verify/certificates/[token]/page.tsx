import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { buildCertificateCredential, certificateCredentialUrl, certificateVerificationUrl, verifyCertificateCredential } from '@/lib/w3c/certificate-credential'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ token: string }> | { token: string } }

function fmt(value: Date | string | null | undefined) {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default async function CertificateVerifyPage({ params }: PageProps) {
  const { token } = await Promise.resolve(params)
  const clean = decodeURIComponent(token || '').trim()
  const cert = clean
    ? await db.certificate.findFirst({
        where: { OR: [{ qrToken: clean }, { serial: clean }] },
        select: {
          id: true,
          serial: true,
          qrToken: true,
          type: true,
          holderName: true,
          program: true,
          grade: true,
          country: true,
          issuedAt: true,
          valid: true,
          userId: true,
          enrollmentId: true,
          admissionId: true,
          agentId: true,
        },
      })
    : null

  if (!cert) {
    return (
      <main dir="rtl" className="min-h-screen bg-[#f8fafc] px-4 py-12">
        <section className="mx-auto max-w-2xl rounded-3xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-2xl text-red-600">!</div>
          <h1 className="text-2xl font-black text-red-700">تعذر التحقق من الشهادة</h1>
          <p className="mt-3 text-sm font-bold leading-7 text-slate-600">الرابط غير صحيح أو أن رمز التحقق غير موجود في سجلات الأكاديمية.</p>
          <a href="/?view=verify" className="mt-6 inline-flex rounded-xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1]">العودة إلى صفحة التحقق</a>
        </section>
      </main>
    )
  }

  const credential = buildCertificateCredential(cert)
  const credentialUrl = certificateCredentialUrl(cert)
  const verificationUrl = certificateVerificationUrl(cert)
  const qr = await QRCode.toDataURL(credentialUrl, { width: 180, margin: 1 }).catch(() => '')
  const proofOk = verifyCertificateCredential(credential)

  return (
    <main dir="rtl" className="min-h-screen bg-gradient-to-b from-[#f8fafc] to-[#f7edd0]/40 px-4 py-10">
      <section className="mx-auto max-w-4xl overflow-hidden rounded-[2rem] border border-[#c9a227]/30 bg-white shadow-xl">
        <div className="bg-[#0f2b46] px-6 py-7 text-[#f5f0e1] sm:px-10">
          <p className="text-xs font-black tracking-[0.25em] text-[#c9a227]" dir="ltr">AACT VERIFICATION</p>
          <h1 className="mt-2 text-2xl font-black sm:text-3xl">التحقق الرسمي من الشهادة</h1>
          <p className="mt-2 text-sm font-bold leading-7 text-blue-100">هذه الصفحة تعرض حالة الشهادة وملف JSON قابل للتحقق وفق نموذج W3C Verifiable Credentials.</p>
        </div>

        <div className="grid gap-6 p-6 sm:grid-cols-[1fr_240px] sm:p-10">
          <div className="space-y-4">
            <div className={`rounded-2xl border p-4 ${cert.valid ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
              <p className={`text-lg font-black ${cert.valid ? 'text-emerald-700' : 'text-amber-700'}`}>{cert.valid ? 'الشهادة صالحة ومسجلة' : 'الشهادة موجودة لكنها غير فعالة'}</p>
              <p className="mt-1 text-xs font-bold text-slate-600">حالة التوقيع الداخلي: {proofOk ? 'تم التحقق من سلامة JSON' : 'تعذر التحقق من سلامة JSON'}</p>
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <Info label="صاحب الشهادة" value={cert.holderName} />
              <Info label="الرقم التسلسلي" value={cert.serial} ltr />
              <Info label="البرنامج / الاعتماد" value={cert.program} wide />
              <Info label="التقدير" value={cert.grade || '—'} />
              <Info label="الدولة" value={cert.country || '—'} />
              <Info label="تاريخ الإصدار" value={fmt(cert.issuedAt)} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-black text-[#0f2b46]">روابط التحقق</p>
              <div className="mt-3 space-y-2 text-xs font-bold">
                <a className="block rounded-lg bg-white p-3 text-[#0f2b46] ring-1 ring-slate-200" href={credentialUrl} target="_blank" rel="noreferrer" dir="ltr">{credentialUrl}</a>
                <a className="block rounded-lg bg-white p-3 text-[#0f2b46] ring-1 ring-slate-200" href={verificationUrl} dir="ltr">{verificationUrl}</a>
              </div>
            </div>
          </div>

          <aside className="rounded-3xl border border-[#c9a227]/30 bg-[#fffaf0] p-5 text-center">
            {qr ? <img src={qr} alt="QR JSON-LD" className="mx-auto h-44 w-44 rounded-xl bg-white p-2 ring-1 ring-[#c9a227]/30" /> : null}
            <p className="mt-3 text-xs font-black text-[#0f2b46]">QR إلى ملف JSON القابل للتحقق</p>
            <p className="mt-2 font-mono text-[11px] font-bold text-slate-500" dir="ltr">{cert.qrToken}</p>
            <a href={`/api/pdf/certificates/${encodeURIComponent(cert.qrToken)}`} className="mt-4 inline-flex w-full justify-center rounded-xl border border-[#c9a227] bg-white px-4 py-2 text-xs font-black text-[#a8841a]">PDF الشهادة</a>
          </aside>
        </div>
      </section>
    </main>
  )
}

function Info({ label, value, ltr, wide }: { label: string; value: string; ltr?: boolean; wide?: boolean }) {
  return (
    <div className={`rounded-2xl border border-slate-100 bg-white p-4 ${wide ? 'sm:col-span-2' : ''}`}>
      <p className="text-[11px] font-black text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-black text-[#0f2b46]" dir={ltr ? 'ltr' : 'rtl'}>{value}</p>
    </div>
  )
}
