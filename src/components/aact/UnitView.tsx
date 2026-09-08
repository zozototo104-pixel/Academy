'use client'

import { useAppStore, api } from '@/lib/store'
import { getSharedAudio, playOnSharedAudio } from '@/lib/audioPlayer'
import { useEffect, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  ArrowRight, ArrowLeft, BookOpen, CheckCircle2, ClipboardCheck,
  Loader2, Target, Bot, Volume2, VolumeX, BookMarked, Download, Hourglass, ExternalLink,
} from 'lucide-react'

interface UnitData {
  unit: {
    id: string
    order: number
    title: string
    summary?: string
    content: { heading: string; body: string }[]
    objectives: string[]
    exam?: { id: string; title: string; passScore: number } | null
  }
  program: { id: string; titleAr: string; slug: string }
  books?: { id: string; title: string; author?: string | null; year?: string | null; hasFile: boolean; link?: string | null; source: string }[]
  finalExam?: { id: string; title: string; durationMin: number; passScore: number; questionCount: number } | null
  semesterExams?: { id: string; title: string; semester: number; durationMin: number; passScore: number; questionCount: number }[]
}

export function UnitView() {
  const { activeUnitId, navigate, openExam, openProgram } = useAppStore()
  const { toast } = useToast()
  const [data, setData] = useState<UnitData | null>(null)
  const [loading, setLoading] = useState(true)
  const [marking, setMarking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!activeUnitId) {
      // فتح /?view=unit مباشرة بلا وحدة — لا لودر لانهائي
      setLoading(false)
      return
    }
    setLoading(true)
    api<UnitData>(`/api/unit?id=${activeUnitId}`)
      .then(setData)
      .catch((e) => toast({ title: 'خطأ', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [activeUnitId])

  const markComplete = async () => {
    if (!data) return
    setMarking(true)
    try {
      await api('/api/progress', {
        method: 'POST',
        body: JSON.stringify({ programId: data.program.id, unitId: data.unit.id }),
      })
      toast({ title: 'أحسنت!', description: 'تم تسجيل إكمال الوحدة' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setMarking(false)
    }
  }

  const readAloud = async () => {
    if (!data) return
    if (speaking && audioEl) {
      audioEl.pause()
      setSpeaking(false)
      return
    }
    try {
      setSpeaking(true)
      const plain = data.unit.content
        .map((s) => `${s.heading}. ${s.body}`)
        .join(' ')
        .slice(0, 3500)
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: plain.slice(0, 950) }),
      })
      if (!res.ok) throw new Error('تعذر توليد الصوت')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      // العنصر الصوتي الدائم المشترك — يعمل على iOS بعد فتح القناة بأول لمسة
      const audio = getSharedAudio()
      audio.onended = () => setSpeaking(false)
      setAudioEl(audio)
      const ok = await playOnSharedAudio(url)
      if (!ok) throw new Error('autoplay blocked')
    } catch (e: any) {
      setSpeaking(false)
      toast({ title: 'تنبيه', description: 'تعذر تشغيل القراءة الصوتية لهذه الوحدة', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex h-72 items-center justify-center">
        <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-slate-500">
        الوحدة غير متاحة —{' '}
        <button className="font-bold text-[#a8841a] underline" onClick={() => navigate('dashboard')}>
          العودة للبوابة
        </button>
      </div>
    )
  }

  const { unit, program } = data

  return (
    <div className="aact-fade-in mx-auto max-w-4xl px-4 py-8">
      {/* Breadcrumb */}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-bold text-slate-400">
        <button onClick={() => openProgram(program.id)} className="hover:text-[#a8841a]">{program.titleAr}</button>
        <span>/</span>
        <span className="text-[#0f2b46]">الوحدة {unit.order}: {unit.title}</span>
      </div>

      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <Badge className="mb-2 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
            <BookOpen className="ml-1 h-3 w-3" /> الوحدة {unit.order}
          </Badge>
          <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">{unit.title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">{unit.summary}</p>
        </div>
        <Button
          size="sm" variant="outline"
          onClick={readAloud}
          className={`shrink-0 border-[#c9a227] ${speaking ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#a8841a]'}`}
        >
          {speaking ? <VolumeX className="ml-1 h-4 w-4" /> : <Volume2 className="ml-1 h-4 w-4" />}
          {speaking ? 'إيقاف' : 'استماع'}
        </Button>
      </div>

      {/* Objectives */}
      {unit.objectives.length > 0 && (
        <Card className="mb-6 border-[#c9a227]/40 bg-[#f7edd0]/40">
          <CardContent className="p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <Target className="h-4 w-4 text-[#a8841a]" /> أهداف التعلم
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {unit.objectives.map((o, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  {o}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Content sections */}
      <div className="space-y-5">
        {unit.content.map((section, i) => (
          <Card key={i} className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <h2 className="mb-3 flex items-center gap-2.5 text-base font-black text-[#0f2b46] sm:text-lg">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0f2b46] text-xs font-black text-[#e0b83a]">
                  {i + 1}
                </span>
                {section.heading}
              </h2>
              <p className="text-sm leading-loose text-slate-700">{section.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* الكتب المقررة للبرنامج */}
      {data.books && data.books.length > 0 && (
        <Card className="mt-8 border-[#c9a227]/40 bg-gradient-to-l from-[#f7edd0]/60 to-white">
          <CardContent className="p-5 sm:p-6">
            <h2 className="mb-1.5 flex items-center gap-2 text-base font-black text-[#0f2b46]">
              <BookMarked className="h-5 w-5 text-[#a8841a]" /> الكتب المقررة لهذا التخصص
            </h2>
            <p className="mb-4 text-xs leading-relaxed text-slate-600">
              الكتب التالية معتمدة من الإدارة وخبير الذكاء الاصطناعي — الاختبار الشامل للبرنامج يُبنى على تحليلها، فاحرص على قراءتها قبل دخول الاختبار.
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {data.books.map((b, i) => (
                <div key={b.id} className="flex items-start gap-3 rounded-xl border border-[#c9a227]/20 bg-white p-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#0f2b46] text-xs font-black text-[#e0b83a]">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-1.5">
                      <h3 className="text-xs font-extrabold leading-snug text-[#0f2b46]">{b.title}</h3>
                      {b.source === 'AI' && (
                        <Badge variant="outline" className="shrink-0 border-[#c9a227]/50 px-1.5 py-0 text-[9px] text-[#a8841a]">
                          اقتراح AI
                        </Badge>
                      )}
                    </div>
                    {b.author && <p className="mt-0.5 text-[10px] font-bold text-slate-500">{b.author}{b.year ? ` — ${b.year}` : ''}</p>}
                    {b.hasFile && (
                      <a
                        href={`/api/books/${b.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700 transition-colors hover:bg-emerald-100"
                      >
                        <Download className="h-3 w-3" /> قراءة / تحميل الكتاب (PDF)
                      </a>
                    )}
                    {b.link && (
                      <a
                        href={b.link}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-black text-blue-700 transition-colors hover:bg-blue-100"
                      >
                        <ExternalLink className="h-3 w-3" /> فتح رابط الكتاب للقراءة
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 12.2: امتحانات الفصول الدراسية من الكتب المقررة */}
      {(data.semesterExams || (data.finalExam ? [data.finalExam] : [])).map((exam: any) => (
        <div key={exam.id} className="mt-4 flex flex-col gap-3 rounded-2xl border border-[#0f2b46]/15 bg-[#0f2b46] p-5 text-[#f5f0e1] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black">
              <BookMarked className="h-4 w-4 text-[#e0b83a]" /> {exam.title}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-[#e0b83a]/90">
              {exam.questionCount} سؤالاً متنوعاً · المدة {exam.durationMin} دقيقة · حد النجاح {exam.passScore}% — مُولَّد ومُصحَّح بخبير الذكاء الاصطناعي
            </p>
          </div>
          <Button
            onClick={() => openExam(exam.id, 'final')}
            className="shrink-0 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
          >
            <Hourglass className="ml-1 h-4 w-4" /> ابدأ امتحان الفصل
          </Button>
        </div>
      ))}

      {/* Actions */}
      <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-[#c9a227]/40 bg-[#f7edd0]/30 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-black text-[#0f2b46]">أنهيت قراءة الوحدة؟</h3>
          <p className="mt-1 text-xs text-slate-600">
            سجّل إكمال الوحدة ثم اختبر معلوماتك في الاختبار — يصححه المشرف الذكي فوراً
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={markComplete} disabled={marking} variant="outline" className="border-emerald-500 font-bold text-emerald-700 hover:bg-emerald-50">
            {marking ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-1 h-4 w-4" />}
            تسجيل الإكمال
          </Button>
          {unit.exam && (
            <Button onClick={() => openExam(unit.exam!.id)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
              <ClipboardCheck className="ml-1 h-4 w-4" /> ابدأ الاختبار
            </Button>
          )}
        </div>
      </div>

      {/* AI helper hint */}
      <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
        <div className="rounded-full bg-[#0f2b46] p-2 text-[#e0b83a]"><Bot className="h-5 w-5" /></div>
        <p className="flex-1 text-xs leading-relaxed text-slate-600">
          لديك سؤال عن هذا المحتوى؟ المشرف الذكي جاهز للإجابة <strong>صوتاً وكتابة</strong> على مدار الساعة.
        </p>
        <Button size="sm" onClick={() => navigate('chat')} className="bg-[#0f2b46] font-bold text-[#e0b83a] hover:bg-[#12365c]">
          اسأل الآن
        </Button>
      </div>

      {/* Nav footer */}
      <div className="mt-6 flex justify-between">
        <Button variant="ghost" onClick={() => navigate('dashboard')} className="text-[#0f2b46]">
          <ArrowRight className="ml-1 h-4 w-4" /> عودة للبوابة
        </Button>
      </div>
    </div>
  )
}
