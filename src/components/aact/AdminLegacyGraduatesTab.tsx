'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Award, Download, FileArchive, FileSpreadsheet, Loader2, Mail, PenLine, Plus, Search, ShieldOff, Upload } from 'lucide-react'

type LegacyGraduateCertificate = {
  id: string
  serial: string
  qrToken: string
  holderName: string
  program: string
  grade?: string | null
  country?: string | null
  issuedAt: string
  valid: boolean
  legacySerial?: string | null
  uploadedFileKey?: string | null
  stampedFileKey?: string | null
  qrPosition?: string | null
  qrSize?: string | null
  user?: { id: string; email: string; name: string; phone?: string | null; country?: string | null } | null
  enrollment?: { id: string; status: string; finalScore?: number | null; certificateNo?: string | null; programId?: string | null } | null
}

type ImportPreviewRow = {
  rowNumber: number
  name?: string | null
  email?: string | null
  program?: string | null
  legacySerial?: string | null
  errors: string[]
  programSuggestion?: string | null
}

type LegacyProgramOption = { id: string; titleAr: string; titleEn?: string | null; slug?: string | null; active?: boolean | null; category?: string | null }

type AddEditForm = {
  id?: string
  name: string
  email: string
  phone: string
  country: string
  programId: string
  program: string
  grade: string
  finalScore: string
  issuedAt: string
  legacySerial: string
}

const blankForm = (): AddEditForm => ({
  name: '',
  email: '',
  phone: '',
  country: '',
  programId: '',
  program: '',
  grade: '',
  finalScore: '',
  issuedAt: '',
  legacySerial: '',
})

function dateOnly(value?: string | null) {
  if (!value) return ''
  return value.slice(0, 10)
}

function apiErrorMessage(data: any, fallback: string) {
  return String(data?.error || data?.message || fallback)
}

async function jsonOrThrow(res: Response, fallback: string) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(apiErrorMessage(data, fallback))
  return data
}

export default function AdminLegacyGraduatesTab() {
  const [items, setItems] = useState<LegacyGraduateCertificate[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<AddEditForm>(blankForm)
  const [uploadFor, setUploadFor] = useState<LegacyGraduateCertificate | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [qrPosition, setQrPosition] = useState('BOTTOM_LEFT')
  const [qrSize, setQrSize] = useState('M')
  const [excelFile, setExcelFile] = useState<File | null>(null)
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([])
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [zipReport, setZipReport] = useState<any>(null)
  const [programOptions, setProgramOptions] = useState<LegacyProgramOption[]>([])
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)

  const invalidImportRows = useMemo(() => importRows.filter((row) => row.errors?.length), [importRows])

  async function load() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      const data = await jsonOrThrow(await fetch(`/api/admin/legacy-graduates?${params.toString()}`, { cache: 'no-store' }), 'تعذر تحميل الخريجين السابقين')
      setItems(data.certificates || [])
    } catch (error: any) {
      toast({ title: 'تعذر تحميل الخريجين السابقين', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  async function loadProgramOptions() {
    try {
      const data = await jsonOrThrow(await fetch('/api/admin/program-catalog?lite=1', { cache: 'no-store' }), 'تعذر تحميل البرامج')
      setProgramOptions(data.programs || [])
    } catch (error: any) {
      toast({ title: 'تعذر تحميل قائمة البرامج', description: String(error?.message || error), variant: 'destructive' })
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); void loadProgramOptions() }, 0)
    return () => window.clearTimeout(timer)
    // Keep the initial fetch tied to mount only; search is refreshed by the explicit search button/Enter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openAdd() {
    setForm(blankForm())
    setFormOpen(true)
  }

  function openEdit(cert: LegacyGraduateCertificate) {
    setForm({
      id: cert.id,
      name: cert.holderName || cert.user?.name || '',
      email: cert.user?.email || '',
      phone: cert.user?.phone || '',
      country: cert.country || cert.user?.country || '',
      programId: cert.enrollment?.programId || '',
      program: cert.program || '',
      grade: cert.grade || '',
      finalScore: cert.enrollment?.finalScore != null ? String(cert.enrollment.finalScore) : '',
      issuedAt: dateOnly(cert.issuedAt),
      legacySerial: cert.legacySerial || '',
    })
    setFormOpen(true)
  }

  async function saveForm(e: FormEvent) {
    e.preventDefault()
    setBusy('form')
    try {
      if (form.id) {
        const data = await jsonOrThrow(await fetch('/api/admin/legacy-graduates', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: form.id,
            holderName: form.name,
            program: form.program,
            grade: form.grade,
            country: form.country,
            finalScore: form.finalScore,
            issuedAt: form.issuedAt,
            legacySerial: form.legacySerial,
          }),
        }), 'تعذر تعديل بيانات الخريج')
        toast({ title: 'تم تعديل بيانات الخريج السابق', description: data.certificate?.serial || '' })
      } else {
        const data = await jsonOrThrow(await fetch('/api/admin/legacy-graduates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            email: form.email,
            phone: form.phone,
            country: form.country,
            programId: form.programId,
            grade: form.grade,
            finalScore: form.finalScore,
            issuedAt: form.issuedAt,
            legacySerial: form.legacySerial,
          }),
        }), 'تعذر إضافة الخريج السابق')
        toast({ title: 'تمت إضافة الخريج السابق', description: `حالة الإيميل: ${data.emailStatus}` })
      }
      setFormOpen(false)
      await load()
    } catch (error: any) {
      toast({ title: form.id ? 'فشل تعديل الخريج' : 'فشل إضافة الخريج', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  function onExcelChange(e: ChangeEvent<HTMLInputElement>) {
    setExcelFile(e.target.files?.[0] || null)
    setImportRows([])
    setImportProgress(null)
  }

  async function runImport(dryRun: boolean) {
    if (!excelFile) return toast({ title: 'اختر ملف Excel أولاً', variant: 'destructive' })
    setBusy(dryRun ? 'dryRun' : 'import')
    setImportProgress(null)
    try {
      if (dryRun) {
        const fd = new FormData()
        fd.append('file', excelFile)
        fd.append('dryRun', 'true')
        const data = await jsonOrThrow(await fetch('/api/admin/legacy-graduates/import?dryRun=true', { method: 'POST', body: fd }), 'تعذر فحص الملف')
        setImportRows(data.rows || [])
        toast({ title: 'تمت معاينة ملف Excel', description: `صالح: ${data.validRows} / أخطاء: ${data.invalidRows}` })
        return
      }

      let offset = 0
      let total = importRows.length || 0
      let successful = 0
      let failed = 0
      setImportProgress({ done: 0, total })
      while (true) {
        const fd = new FormData()
        fd.append('file', excelFile)
        fd.append('dryRun', 'false')
        fd.append('offset', String(offset))
        fd.append('limit', '50')
        const data = await jsonOrThrow(await fetch('/api/admin/legacy-graduates/import?dryRun=false', { method: 'POST', body: fd }), 'تعذر حفظ الاستيراد')
        total = Number(data.totalRows || total || 0)
        successful += Number(data.successful || 0)
        failed += Number(data.failed || 0)
        offset = data.nextOffset == null ? total : Number(data.nextOffset)
        setImportProgress({ done: Math.min(offset, total), total })
        if (data.nextOffset == null) break
      }
      toast({ title: 'تم استيراد الملف', description: `نجح: ${successful} / فشل: ${failed}` })
      setImportRows([])
      await load()
    } catch (error: any) {
      toast({ title: dryRun ? 'فشل فحص الملف' : 'فشل الاستيراد', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function uploadZip() {
    if (!zipFile) return toast({ title: 'اختر ملف ZIP أولاً', variant: 'destructive' })
    setBusy('zip')
    try {
      const fd = new FormData()
      fd.append('file', zipFile)
      const data = await jsonOrThrow(await fetch('/api/admin/legacy-graduates/import-files', { method: 'POST', body: fd }), 'تعذر رفع ملفات الشهادات')
      setZipReport(data)
      toast({ title: 'تمت معالجة ZIP', description: `نجح: ${data.successful} / غير مرتبط: ${data.notFound} / مرفوض: ${data.rejected}` })
      await load()
    } catch (error: any) {
      toast({ title: 'فشل رفع ZIP', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  function openUpload(cert: LegacyGraduateCertificate) {
    setUploadFor(cert)
    setUploadFile(null)
    setQrPosition(cert.qrPosition || 'BOTTOM_LEFT')
    setQrSize(cert.qrSize || 'M')
  }

  async function stampUpload(preview: boolean) {
    if (!uploadFor) return
    if (!uploadFile && !uploadFor.uploadedFileKey) return toast({ title: 'ارفع ملف الشهادة أولاً', variant: 'destructive' })
    setBusy(preview ? 'preview' : 'upload')
    try {
      const fd = new FormData()
      if (uploadFile) fd.append('file', uploadFile)
      fd.append('qrPosition', qrPosition)
      fd.append('qrSize', qrSize)
      const res = await fetch(`/api/admin/legacy-graduates/${uploadFor.id}/upload${preview ? '?preview=true' : ''}`, { method: 'POST', body: fd })
      if (preview) {
        if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), 'تعذر إنشاء المعاينة'))
        const blob = await res.blob()
        window.open(URL.createObjectURL(blob), '_blank')
      } else {
        const data = await jsonOrThrow(res, 'تعذر حفظ الشهادة المختومة')
        toast({ title: 'تم حفظ الشهادة المختومة', description: data.stampedFileKey || uploadFor.serial })
        setUploadFor(null)
        await load()
      }
    } catch (error: any) {
      toast({ title: preview ? 'فشل إنشاء المعاينة' : 'فشل حفظ الملف المختوم', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function resendInvite(cert: LegacyGraduateCertificate) {
    setBusy(`invite:${cert.id}`)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/legacy-graduates/${cert.id}/resend-invite`, { method: 'POST' }), 'تعذر إرسال رابط التفعيل')
      toast({ title: 'تمت محاولة إرسال رابط التفعيل', description: `حالة الإيميل: ${data.emailStatus}` })
    } catch (error: any) {
      toast({ title: 'فشل إرسال رابط التفعيل', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function revoke(cert: LegacyGraduateCertificate) {
    const reason = window.prompt('سبب إلغاء الشهادة؟', 'إلغاء إداري')
    if (reason == null) return
    setBusy(`revoke:${cert.id}`)
    try {
      await jsonOrThrow(await fetch('/api/admin/legacy-graduates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cert.id, action: 'revoke', reason }),
      }), 'تعذر إلغاء الشهادة')
      toast({ title: 'تم إلغاء الشهادة', description: cert.serial })
      await load()
    } catch (error: any) {
      toast({ title: 'فشل إلغاء الشهادة', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-4 space-y-4" dir="rtl">
      <Card className="border-[#0f2b46]/10">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-black text-[#0f2b46]"><Award className="h-5 w-5 text-[#c9a227]" /> الخريجون السابقون</h3>
              <p className="text-xs font-bold text-slate-500">إدخال خريجين أنهوا الدراسة قبل إطلاق المنصة وربط شهاداتهم بحسابات قابلة للتحقق.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={openAdd} className="gap-2 bg-[#0f2b46] text-white hover:bg-[#12365c]"><Plus className="h-4 w-4" /> إضافة خريج</Button>
              <Button variant="outline" onClick={() => window.open('/api/admin/legacy-graduates/template', '_blank')} className="gap-2"><FileSpreadsheet className="h-4 w-4" /> تحميل نموذج Excel</Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load() }} placeholder="بحث بالاسم أو الإيميل أو رقم الشهادة" className="pr-9" />
            </div>
            <Button variant="outline" onClick={load} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'بحث'}</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[#0f2b46]/10">
        <CardContent className="space-y-3 p-4">
          <h4 className="font-black text-[#0f2b46]">استيراد Excel</h4>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Input type="file" accept=".xlsx,.xls,.csv" onChange={onExcelChange} />
            <Button variant="outline" onClick={() => runImport(true)} disabled={busy === 'dryRun'}>{busy === 'dryRun' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'معاينة الأخطاء'}</Button>
            <Button onClick={() => runImport(false)} disabled={!excelFile || importRows.length === 0 || invalidImportRows.length > 0 || busy === 'import'}>{busy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'حفظ الاستيراد'}</Button>
          </div>
          {importProgress ? <p className="text-xs font-bold text-[#0f2b46]">تم {importProgress.done} من {importProgress.total}</p> : null}
          {importRows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[760px] text-right text-xs">
                <thead className="bg-slate-50 text-slate-600"><tr><th className="p-2">السطر</th><th className="p-2">الاسم</th><th className="p-2">الإيميل</th><th className="p-2">البرنامج</th><th className="p-2">رقم قديم</th><th className="p-2">الأخطاء</th></tr></thead>
                <tbody>{importRows.map((row) => <tr key={row.rowNumber} className="border-t"><td className="p-2 font-bold">{row.rowNumber}</td><td className="p-2">{row.name || '—'}</td><td className="p-2 ltr:text-left">{row.email || '—'}</td><td className="p-2">{row.program || '—'}{row.programSuggestion ? <div className="text-[10px] text-amber-700">اقتراح: {row.programSuggestion}</div> : null}</td><td className="p-2">{row.legacySerial || '—'}</td><td className="p-2"><span className={row.errors.length ? 'text-red-600' : 'text-emerald-700'}>{row.errors.length ? row.errors.join('، ') : 'صالح'}</span></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-[#0f2b46]/10">
        <CardContent className="space-y-3 p-4">
          <h4 className="font-black text-[#0f2b46]">رفع شهادات ZIP</h4>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Input type="file" accept=".zip,application/zip" onChange={(e) => setZipFile(e.target.files?.[0] || null)} />
            <Button variant="outline" onClick={uploadZip} disabled={busy === 'zip'} className="gap-2"><FileArchive className="h-4 w-4" /> {busy === 'zip' ? 'جاري المعالجة...' : 'رفع شهادات ZIP'}</Button>
          </div>
          {zipReport ? <p className="text-xs font-bold text-slate-600">النتيجة: نجح {zipReport.successful}، غير مرتبط {zipReport.notFound}، مرفوض {zipReport.rejected}، فشل {zipReport.failed}</p> : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {items.map((cert) => (
          <Card key={cert.id} className="border-[#0f2b46]/10">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-black text-[#0f2b46]">{cert.holderName}</h4>
                    <Badge variant={cert.valid ? 'default' : 'destructive'}>{cert.valid ? 'صالحة' : 'ملغاة'}</Badge>
                    {cert.stampedFileKey ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">ملف مختوم</Badge> : <Badge variant="outline">PDF من القالب</Badge>}
                  </div>
                  <p className="text-xs font-bold text-slate-600">{cert.user?.email || 'بدون إيميل'} · {cert.program}</p>
                  <p className="text-xs text-slate-500">الرقم: <span dir="ltr">{cert.serial}</span>{cert.legacySerial ? <> · الرقم القديم: <span dir="ltr">{cert.legacySerial}</span></> : null} · تاريخ التخرج: {dateOnly(cert.issuedAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => openUpload(cert)} className="gap-1"><Upload className="h-3.5 w-3.5" /> رفع/ختم</Button>
                  <Button size="sm" variant="outline" onClick={() => window.open(`/api/pdf/certificates/${encodeURIComponent(cert.serial)}`, '_blank')} className="gap-1"><Download className="h-3.5 w-3.5" /> تحميل PDF</Button>
                  <Button size="sm" variant="outline" onClick={() => resendInvite(cert)} disabled={busy === `invite:${cert.id}`} className="gap-1"><Mail className="h-3.5 w-3.5" /> إرسال التفعيل</Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(cert)} className="gap-1"><PenLine className="h-3.5 w-3.5" /> تعديل</Button>
                  {cert.valid ? <Button size="sm" variant="destructive" onClick={() => revoke(cert)} disabled={busy === `revoke:${cert.id}`} className="gap-1"><ShieldOff className="h-3.5 w-3.5" /> إلغاء</Button> : null}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {!loading && items.length === 0 ? <Card><CardContent className="p-8 text-center text-sm font-bold text-slate-500">لا توجد سجلات خريجين سابقين بعد.</CardContent></Card> : null}
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'تعديل خريج سابق' : 'إضافة خريج سابق'}</DialogTitle>
            <DialogDescription>لا يتم تغيير رمز QR عند تعديل بيانات شهادة موجودة.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveForm} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>الاسم</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
              <div><Label>الإيميل</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required={!form.id} disabled={!!form.id} dir="ltr" /></div>
              <div><Label>الجوال</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={!!form.id} dir="ltr" /></div>
              <div><Label>الدولة</Label><Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></div>
              {!form.id ? <div><Label>البرنامج</Label><Select value={form.programId} onValueChange={(programId) => { const p = programOptions.find((item) => item.id === programId); setForm({ ...form, programId, program: p?.titleAr || p?.titleEn || '' }) }}><SelectTrigger><SelectValue placeholder="اختر البرنامج" /></SelectTrigger><SelectContent>{programOptions.map((program) => <SelectItem key={program.id} value={program.id}>{program.titleAr || program.titleEn || program.slug || program.id}{program.active === false ? ' — مخفي' : ''}</SelectItem>)}</SelectContent></Select></div> : <div><Label>اسم البرنامج على الشهادة</Label><Input value={form.program} onChange={(e) => setForm({ ...form, program: e.target.value })} required /></div>}
              <div><Label>التقدير</Label><Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></div>
              <div><Label>المعدل</Label><Input value={form.finalScore} onChange={(e) => setForm({ ...form, finalScore: e.target.value })} dir="ltr" /></div>
              <div><Label>تاريخ التخرج</Label><Input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} required /></div>
              <div><Label>رقم الشهادة الورقية</Label><Input value={form.legacySerial} onChange={(e) => setForm({ ...form, legacySerial: e.target.value })} dir="ltr" /></div>
            </div>
            <DialogFooter className="gap-2"><Button type="button" variant="outline" onClick={() => setFormOpen(false)}>إلغاء</Button><Button type="submit" disabled={busy === 'form'}>{busy === 'form' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'حفظ'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!uploadFor} onOpenChange={(open) => { if (!open) setUploadFor(null) }}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>رفع شهادة جاهزة وختم QR</DialogTitle>
            <DialogDescription>{uploadFor ? `${uploadFor.holderName} — ${uploadFor.serial}` : ''}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>مكان QR</Label><Select value={qrPosition} onValueChange={setQrPosition}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="BOTTOM_LEFT">أسفل يسار</SelectItem><SelectItem value="BOTTOM_RIGHT">أسفل يمين</SelectItem><SelectItem value="TOP_LEFT">أعلى يسار</SelectItem><SelectItem value="TOP_RIGHT">أعلى يمين</SelectItem></SelectContent></Select></div>
              <div><Label>حجم QR</Label><Select value={qrSize} onValueChange={setQrSize}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="S">صغير</SelectItem><SelectItem value="M">متوسط</SelectItem><SelectItem value="L">كبير</SelectItem></SelectContent></Select></div>
            </div>
            <Textarea readOnly value="تغيير مكان أو حجم QR يعيد الختم من الملف الأصلي عند عدم رفع ملف جديد." />
          </div>
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => stampUpload(true)} disabled={busy === 'preview'}>معاينة</Button><Button onClick={() => stampUpload(false)} disabled={busy === 'upload'}>{busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'حفظ المختوم'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
