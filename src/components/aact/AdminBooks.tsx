'use client'

import { api } from '@/lib/store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  BookMarked, Loader2, Plus, Sparkles, Trash2, FileText, Bot,
  Hourglass, RefreshCw, Upload, CheckCircle2, AlertTriangle, XCircle, ClipboardList,
  Layers, FileCheck2, Link2,
} from 'lucide-react'
import { QuestionReviewDialog, AdminAppealsSection } from '@/components/aact/AdminExamReview'

interface ProgramOption {
  id: string
  titleAr: string
  category: string
}

interface BookRow {
  id: string
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  fileName?: string | null
  size?: number | null
  link?: string | null
  source: string
  semester?: number | null
  hasFile: boolean
}

interface Suggestion {
  title: string
  titleEn: string
  author: string
  year: string
  reason: string
  link: string
  added?: boolean
}

interface ExamRow {
  id: string
  title: string
  status: string
  semester: number
  errorNote?: string | null
  durationMin: number
  passScore: number
  booksUsed?: string | null
  questionCount: number
  byType: Record<string, number>
  totalPoints: number
  pendingReview: number
  rejectedCount: number
  attemptsCount: number
  createdAt: string
}

const TYPE_AR: Record<string, string> = { MCQ: 'اختيار', TF: 'صح/خطأ', SHORT: 'إجابة قصيرة', ESSAY: 'مقالي' }
const CAT_AR: Record<string, string> = { DOCTORATE: 'دكتوراه', MASTERS: 'ماجستير', DIPLOMA: 'دبلوم', ACCREDITATION: 'اعتماد' }

export function AdminBooksTab() {
  const { toast } = useToast()
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [programId, setProgramId] = useState<string>('')
  const [books, setBooks] = useState<BookRow[]>([])
  const [exams, setExams] = useState<ExamRow[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [adding, setAdding] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [form, setForm] = useState({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [genSemester, setGenSemester] = useState('1')
  const [reviewingExam, setReviewingExam] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    api<{ programs: ProgramOption[] }>('/api/programs')
      .then((d) => setPrograms(d.programs))
      .catch(() => {})
      .finally(() => setLoading(false))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const loadProgramData = useCallback(async (pid: string, silent = false) => {
    if (!pid) return
    if (!silent) setLoadingBooks(true)
    try {
      const [b, e] = await Promise.all([
        api<{ books: BookRow[] }>(`/api/admin/books?programId=${pid}`),
        api<{ exams: ExamRow[] }>(`/api/admin/program-exams?programId=${pid}`),
      ])
      setBooks(b.books)
      setExams(e.exams)
    } catch (err: any) {
      if (!silent) toast({ title: 'خطأ', description: err.message, variant: 'destructive' })
    } finally {
      if (!silent) setLoadingBooks(false)
    }
  }, [toast])

  // استطلاع دوري أثناء وجود اختبار قيد التوليد
  useEffect(() => {
    const anyGenerating = exams.some((e) => e.status === 'GENERATING')
    if (anyGenerating && programId && !pollRef.current) {
      pollRef.current = setInterval(() => loadProgramData(programId, true), 5000)
    } else if (!anyGenerating && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
      // تحديث نهائي بعد اكتمال التوليد
      if (programId) loadProgramData(programId, true)
    }
  }, [exams, programId, loadProgramData])

  const addBook = async (payload?: Partial<Suggestion>) => {
    if (!programId) return
    const title = payload?.title ?? form.title
    if (!title.trim()) {
      toast({ title: 'تنبيه', description: 'اكتب اسم الكتاب أولاً', variant: 'destructive' })
      return
    }
    setAdding(true)
    try {
      const fd = new FormData()
      fd.append('programId', programId)
      fd.append('title', title)
      fd.append('titleEn', payload?.titleEn ?? form.titleEn)
      fd.append('author', payload?.author ?? form.author)
      fd.append('year', payload?.year ?? form.year)
      fd.append('description', payload?.reason ?? form.description)
      fd.append('semester', payload ? '' : form.semester)
      fd.append('link', payload ? payload.link || '' : form.link)
      if (!payload && file) fd.append('file', file)
      const d = await api<{ book: BookRow; textExtracted: boolean; linkNote?: string | null }>('/api/admin/books', { method: 'POST', body: fd })
      setBooks((prev) => [...prev, { ...d.book, hasFile: !!d.book.fileName, source: d.book.source || 'ADMIN' }])
      if (!payload) {
        setForm({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
        setFile(null)
        if (fileRef.current) fileRef.current.value = ''
      }
      toast({
        title: 'تمت إضافة الكتاب',
        description: d.textExtracted
          ? 'تمت قراءة محتوى الملف/الرابط — خبير الذكاء الاصطناعي سيستخدمه في بناء الأسئلة'
          : d.linkNote || 'أُضيف إلى الكتب المقررة للتخصص',
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setAdding(false)
    }
  }

  const deleteBook = async (id: string) => {
    if (!confirm('حذف هذا الكتاب من الكتب المقررة؟')) return
    try {
      await api(`/api/admin/books?bookId=${id}`, { method: 'DELETE' })
      setBooks((prev) => prev.filter((b) => b.id !== id))
      toast({ title: 'تم الحذف' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const suggest = async () => {
    if (!programId) return
    setSuggesting(true)
    setSuggestions([])
    try {
      const d = await api<{ suggestions: Suggestion[] }>('/api/admin/books/suggest', {
        method: 'POST',
        body: JSON.stringify({ programId }),
      })
      setSuggestions(d.suggestions)
      toast({ title: 'اقتراحات خبير الذكاء الاصطناعي جاهزة', description: `${d.suggestions.length} كتاباً مقترحاً وفق واقع التخصص عالمياً` })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSuggesting(false)
    }
  }

  const suggestAll = async () => {
    for (const s of suggestions.filter((x) => !x.added)) {
      await addBook(s)
      setSuggestions((prev) => prev.map((x) => (x.title === s.title ? { ...x, added: true } : x)))
    }
    toast({ title: 'تمت إضافة كل الكتب المقترحة' })
  }

  const generateExam = async () => {
    if (!programId) return
    if (books.length === 0) {
      toast({ title: 'لا يمكن التوليد', description: 'أضف كتباً مقررة للتخصص أولاً — يدوياً أو من اقتراحات خبير الذكاء الاصطناعي', variant: 'destructive' })
      return
    }
    const semLabel = genSemester === '2' ? 'الفصل الثاني' : 'الفصل الأول'
    if (!confirm(`سيولّد خبير الذكاء الاصطناعي امتحان ${semLabel} (${books.length} كتاب مقرر متاح) بعدد كبير من الأسئلة المتنوعة ومدة لا تقل عن ساعتين، ثم تمرّ الأسئلة على مراجعتك قبل النشر. التوليد يستغرق عدة دقائق. متابعة؟`)) return
    setGenerating(true)
    try {
      const d = await api<{ examId: string; booksCount: number }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ programId, semester: genSemester === '2' ? 2 : 1 }),
      })
      toast({ title: 'بدأ التوليد', description: `خبير الذكاء الاصطناعي يقرأ ${d.booksCount} كتاباً ويحللها لتوليد أسئلة ${semLabel} — تابع الحالة بالأسفل` })
      await loadProgramData(programId, true)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  const deleteExam = async (id: string) => {
    if (!confirm('حذف هذا الاختبار الشامل وكل محاولاته؟')) return
    try {
      await api(`/api/admin/program-exams?id=${id}`, { method: 'DELETE' })
      setExams((prev) => prev.filter((e) => e.id !== id))
      toast({ title: 'تم حذف الاختبار' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-5">
      {/* اختيار البرنامج */}
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <Label className="mb-2 block text-xs font-black text-[#0f2b46]">اختر التخصص/البرنامج لإدارة كتبه واختباراته</Label>
          <Select value={programId} onValueChange={(v) => { setProgramId(v); setSuggestions([]); loadProgramData(v) }}>
            <SelectTrigger className="h-11 w-full max-w-xl text-sm font-bold">
              <SelectValue placeholder="اختر برنامجاً..." />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {programs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.titleAr} — {CAT_AR[p.category] || p.category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {programId && (
        <>
          {/* الكتب المقررة */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <BookMarked className="h-4.5 w-4.5 text-[#a8841a]" />
                  الكتب المقررة التي يجب على الطالب قراءتها ({books.length})
                </h2>
                <Button size="sm" variant="outline" onClick={suggest} disabled={suggesting} className="border-[#c9a227] font-bold text-[#a8841a]">
                  {suggesting ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                  اقترح كتباً بالذكاء الاصطناعي
                </Button>
              </div>

              {loadingBooks ? (
                <div className="flex h-24 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
              ) : books.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">
                  لا توجد كتب مقررة لهذا التخصص بعد — أضفها يدوياً بالأسفل أو اطلب اقتراحات خبير الذكاء الاصطناعي
                </div>
              ) : (
                <div className="aact-scroll max-h-80 space-y-2.5 overflow-y-auto">
                  {books.map((b, i) => (
                    <div key={b.id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-white p-3.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0f2b46] text-[10px] font-black text-[#e0b83a]">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="text-xs font-extrabold text-[#0f2b46]">{b.title}</h3>
                          {b.source === 'AI' ? (
                            <Badge className="bg-[#f7edd0] text-[9px] text-[#a8841a] hover:bg-[#f7edd0]">اقتراح خبير AI</Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-200 px-1.5 py-0 text-[9px] text-slate-500">إدارة</Badge>
                          )}
                          {b.semester ? (
                            <Badge variant="outline" className="border-[#c9a227]/40 text-[9px] text-[#a8841a]">
                              <Layers className="ml-0.5 h-2.5 w-2.5" /> {b.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-200 text-[9px] text-slate-400">عام للبرنامج</Badge>
                          )}
                        </div>
                        {(b.author || b.year) && (
                          <p className="mt-0.5 text-[10px] font-bold text-slate-500">{b.author}{b.year ? ` — ${b.year}` : ''}{b.titleEn ? ` · ${b.titleEn}` : ''}</p>
                        )}
                        {b.description && <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{b.description}</p>}
                        {b.hasFile && (
                          <a href={`/api/books/${b.id}/file`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 hover:bg-emerald-100">
                            <FileText className="h-3 w-3" /> {b.fileName} ({Math.ceil((b.size || 0) / 1024)} ك.ب)
                          </a>
                        )}
                        {b.link && (
                          <a href={b.link} target="_blank" rel="noreferrer" className="ml-1.5 mt-1.5 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700 hover:bg-blue-100">
                            <Link2 className="h-3 w-3" /> فتح رابط الكتاب
                          </a>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => deleteBook(b.id)} className="shrink-0 text-red-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* اقتراحات خبير الذكاء الاصطناعي */}
              {suggestions.length > 0 && (
                <div className="mt-4 rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                      <Bot className="h-4 w-4 text-[#a8841a]" /> اقتراحات خبير الذكاء الاصطناعي وفق واقع التخصص عالمياً
                    </h3>
                    <Button size="sm" onClick={suggestAll} className="bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#12365c]">
                      <Plus className="ml-1 h-3 w-3" /> إضافة الكل
                    </Button>
                  </div>
                  <div className="aact-scroll max-h-72 space-y-2 overflow-y-auto">
                    {suggestions.map((s, i) => (
                      <div key={i} className={`rounded-lg border bg-white p-3 ${s.added ? 'border-emerald-200 opacity-70' : 'border-[#c9a227]/20'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="text-xs font-extrabold text-[#0f2b46]">{s.title}</h4>
                            <p className="mt-0.5 text-[10px] font-bold text-slate-500" dir="auto">{s.titleEn} — {s.author} {s.year && `(${s.year})`}</p>
                            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{s.reason}</p>
                            {s.link && (
                              <a href={s.link} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700 hover:bg-blue-100">
                                <Link2 className="h-3 w-3" /> رابط الكتاب — تحقق منه قبل الإضافة
                              </a>
                            )}
                          </div>
                          {s.added ? (
                            <Badge className="shrink-0 bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> أُضيف</Badge>
                          ) : (
                            <Button size="sm" onClick={() => addBook(s)} disabled={adding} className="shrink-0 bg-[#c9a227] text-[10px] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                              <Plus className="ml-1 h-3 w-3" /> إضافة
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* نموذج إضافة كتاب */}
              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <h3 className="mb-3 flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                  <Plus className="h-4 w-4 text-[#a8841a]" /> إضافة كتاب مقرر جديد
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">اسم الكتاب (عربي) *</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: إدارة الموارد البشرية الحديثة" className="mt-1 h-9 text-xs" />
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">العنوان بالإنجليزية</Label>
                    <Input value={form.titleEn} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} placeholder="Original title" className="mt-1 h-9 text-xs" dir="ltr" />
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">المؤلف</Label>
                    <Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} className="mt-1 h-9 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">رابط الكتاب على الإنترنت (للقراءة أو التحميل — يقرأه خبير الذكاء الاصطناعي إن كان PDF أو صفحة نصية)</Label>
                    <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://example.com/book.pdf أو رابط صفحة الكتاب" className="mt-1 h-9 text-xs" dir="ltr" />
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">سنة النشر</Label>
                    <Input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} className="mt-1 h-9 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">لماذا هذا الكتاب مطلوب في التخصص</Label>
                    <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="نبذة عن قيمة الكتاب ودوره في المنهج..." className="mt-1 min-h-16 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">الفصل الدراسي المعتمد عليه</Label>
                    <Select value={form.semester || 'any'} onValueChange={(v) => setForm({ ...form, semester: v === 'any' ? '' : v })}>
                      <SelectTrigger className="mt-1 h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">عام — يدخل في الفصلين</SelectItem>
                        <SelectItem value="1">الفصل الدراسي الأول</SelectItem>
                        <SelectItem value="2">الفصل الدراسي الثاني</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">ملف الكتاب (PDF — يقرأه خبير الذكاء الاصطناعي لبناء الأسئلة، حتى 10 ميجابايت)</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".pdf,application/pdf,.txt"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        className="block w-full max-w-sm text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-[#0f2b46] file:px-3 file:py-1.5 file:text-[10px] file:font-black file:text-[#e0b83a]"
                      />
                      {file && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><Upload className="ml-1 h-3 w-3" /> {file.name}</Badge>}
                    </div>
                  </div>
                </div>
                <Button onClick={() => addBook()} disabled={adding} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                  {adding ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Plus className="ml-1 h-4 w-4" />}
                  إضافة الكتاب للكتب المقررة
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* الاختبارات الشاملة المولدة */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <ClipboardList className="h-4.5 w-4.5 text-[#a8841a]" />
                  امتحانات الفصول الدراسية المولدة من الكتب ({exams.length})
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={genSemester} onValueChange={setGenSemester}>
                    <SelectTrigger className="h-9 w-44 text-xs font-bold">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">امتحان الفصل الأول</SelectItem>
                      <SelectItem value="2">امتحان الفصل الثاني</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={generateExam} disabled={generating || exams.some((e) => e.status === 'GENERATING')} className="bg-emerald-600 font-black text-white hover:bg-emerald-700">
                    {generating || exams.some((e) => e.status === 'GENERATING') ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                    توليد بالذكاء الاصطناعي
                  </Button>
                </div>
              </div>

              {exams.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-xs leading-relaxed text-slate-500">
                  لم يولَّد امتحان لهذا التخصص بعد. كل برنامج له امتحانان: نهاية الفصل الأول ونهاية الفصل الثاني.<br />
                  عند التوليد يقرأ خبير الذكاء الاصطناعي كل الكتب المقررة ويحللها ثم يضع امتحاناً بمجموع كبير من الأسئلة المتنوعة
                  (اختيار من متعدد، صح/خطأ، إجابة قصيرة، مقالي، حالات عملية) بمدة لا تقل عن ساعتين — ثم تمرّ الأسئلة على مراجعتك واعتمادك قبل نشرها للطلاب.
                </div>
              ) : (
                <div className="space-y-3">
                  {exams.map((e) => (
                    <div key={e.id} className="rounded-xl border border-slate-100 bg-white p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-xs font-extrabold text-[#0f2b46]">{e.title}</h3>
                            <Badge variant="outline" className="border-[#0f2b46]/30 text-[9px] font-bold text-[#0f2b46]">
                              <Layers className="ml-0.5 h-2.5 w-2.5" /> {e.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'}
                            </Badge>
                            {e.status === 'GENERATING' && (
                              <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
                                <Loader2 className="ml-1 h-3 w-3 animate-spin" /> جاري التوليد والتحليل ({e.questionCount} سؤالاً حتى الآن)...
                              </Badge>
                            )}
                            {e.status === 'REVIEW' && (
                              <Badge className="bg-[#f7edd0] text-[#a8841a] hover:bg-[#f7edd0]">
                                <FileCheck2 className="ml-1 h-3 w-3" /> بانتظار مراجعتك واعتماد الأسئلة ({e.pendingReview} سؤالاً)
                              </Badge>
                            )}
                            {e.status === 'READY' && (
                              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                                <CheckCircle2 className="ml-1 h-3 w-3" /> منشور للطلاب
                              </Badge>
                            )}
                            {e.status === 'FAILED' && (
                              <Badge className="bg-red-100 text-red-700 hover:bg-red-100"><XCircle className="ml-1 h-3 w-3" /> فشل</Badge>
                            )}
                          </div>
                          {e.status === 'FAILED' && e.errorNote && (
                            <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-red-500">
                              <AlertTriangle className="h-3 w-3" /> {e.errorNote} — أعد المحاولة
                            </p>
                          )}
                          {e.status === 'READY' && (
                            <>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {Object.entries(e.byType).map(([t, n]) => (
                                  <Badge key={t} variant="outline" className="border-[#c9a227]/40 text-[10px] font-bold text-[#a8841a]">
                                    {n} {TYPE_AR[t] || t}
                                  </Badge>
                                ))}
                              </div>
                              <p className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-black text-[#0f2b46]">
                                <span className="flex items-center gap-1"><ClipboardList className="h-3.5 w-3.5 text-[#a8841a]" /> {e.questionCount} سؤالاً</span>
                                <span className="flex items-center gap-1"><Hourglass className="h-3.5 w-3.5 text-[#a8841a]" /> {e.durationMin} دقيقة</span>
                                <span>{e.totalPoints} نقطة</span>
                                <span>· {e.attemptsCount} محاولة طلاب</span>
                              </p>
                              {e.booksUsed && (
                                <p className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-slate-400">بُني على: {e.booksUsed}</p>
                              )}
                            </>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {(e.status === 'REVIEW' || e.status === 'READY') && (
                            <Button size="sm" onClick={() => setReviewingExam({ id: e.id, title: e.title })}
                              className={`h-8 text-[10px] font-black ${e.status === 'REVIEW' ? 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]' : 'border border-[#0f2b46]/20 bg-transparent text-[#0f2b46] hover:bg-slate-50'}`}>
                              <FileCheck2 className="ml-1 h-3 w-3" />
                              {e.status === 'REVIEW' ? 'مراجعة الأسئلة واعتمادها' : 'عرض الأسئلة المعتمدة'}
                            </Button>
                          )}
                          {e.status === 'READY' && (
                            <Button size="sm" variant="ghost" onClick={() => deleteExam(e.id)} className="text-slate-400 hover:bg-red-50 hover:text-red-600" title="حذف">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {(e.status === 'FAILED' || e.status === 'REVIEW') && (
                            <Button size="sm" variant="ghost" onClick={() => deleteExam(e.id)} className="text-red-400 hover:bg-red-50 hover:text-red-600" title="حذف وإعادة المحاولة">
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                ملاحظة: التوليد يتم على مراحل (مفاهيم ← تطبيق ← تحليل ← مقالي ← حالات عملية) وقد يستغرق عدة دقائق حسب عدد الكتب — تُحدَّث الحالة تلقائياً.
                بعد التوليد تمرّ الأسئلة على مراجعتك (تعديل/اعتماد/رفض) ولا يراها الطالب إلا بعد اعتمادها ونشرها — عندها يصل إشعار لكل الطلاب المسجلين.
              </p>
            </CardContent>
          </Card>

          {/* 12.2: الاعتراضات على النتائج */}
          <AdminAppealsSection />
        </>
      )}

      {/* حوار مراجعة الأسئلة قبل النشر */}
      {reviewingExam && (
        <QuestionReviewDialog
          examId={reviewingExam.id}
          examTitle={reviewingExam.title}
          open={!!reviewingExam}
          onClose={() => setReviewingExam(null)}
          onPublished={() => programId && loadProgramData(programId, true)}
        />
      )}
    </div>
  )
}
