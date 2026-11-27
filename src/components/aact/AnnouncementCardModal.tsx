'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { LecturePlayer } from '@/components/aact/LecturePlayer'
import { announcementVideoDescriptor, firstUnseenAnnouncementCard, type SiteAnnouncement } from '@/lib/site-announcements-core'
import { Button } from '@/components/ui/button'

// نافذة «البطاقة البارزة» على طريقة منصات «ما الجديد»: تظهر مرة واحدة
// عند أول دخول للمستخدم للمنصة، ثم لا تعود أبداً لنفس الإعلان.
// التذكّر محلي في المتصفح (localStorage) لكل إعلان على حدة — بلا هجرة
// قاعدة بيانات وبلا تتبّع على الخادم. حدّه الصادق: جهاز واحد = تذكّر
// واحد؛ من يفتح من هاتف وحاسوب يراها مرة على كل جهاز.
const SEEN_KEY_PREFIX = 'aact-announcement-seen:'

function seenKey(id: string) {
  return `${SEEN_KEY_PREFIX}${id}`
}

export function AnnouncementCardModal({ cards }: { cards: SiteAnnouncement[] }) {
  const [current, setCurrent] = useState<SiteAnnouncement | null>(null)
  const [visible, setVisible] = useState(false)

  const dismiss = useCallback(() => {
    if (!current) return
    try {
      window.localStorage.setItem(seenKey(current.id), '1')
    } catch {
      // التخزين المحلي محظور في هذا المتصفح — النافذة ستعود في الدخول التالي.
    }
    setVisible(false)
  }, [current])

  useEffect(() => {
    if (!cards.length) return
    // التأخير القصير يترك الصفحة ترسم أولاً، والاختيار يتم داخل المؤقت
    // (لا setState مباشرة في جسم الـ effect).
    const timer = window.setTimeout(() => {
      let seenIds: string[] = []
      try {
        seenIds = cards.filter((item) => window.localStorage.getItem(seenKey(item.id))).map((item) => item.id)
      } catch {
        seenIds = []
      }
      const next = firstUnseenAnnouncementCard(cards, seenIds)
      if (!next) return
      setCurrent(next)
      setVisible(true)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [cards])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible, dismiss])

  if (!current || !visible) return null

  const descriptor = announcementVideoDescriptor(current.videoUrl)
  const images = current.imageUrls || []

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={dismiss} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={current.title} className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-[#c9a227]/40 bg-white p-5 shadow-2xl sm:p-6">
        <button
          type="button"
          aria-label="إغلاق الإعلان"
          onClick={dismiss}
          className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-black text-slate-500">
          <span className="rounded-full bg-[#fffaf0] px-3 py-1 text-[#a8841a]">إعلان</span>
        </div>
        <h2 className="mt-3 pl-8 text-lg font-black leading-relaxed text-[#0f2b46] sm:text-2xl">{current.title}</h2>
        <p className="mt-2 text-sm font-bold leading-8 text-slate-600">{current.summary}</p>
        {descriptor && (
          <div className="mt-4">
            <LecturePlayer descriptor={descriptor} title={current.title} />
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            {images.map((url) => (
              <img key={url} src={url} alt={current.title} className="aspect-video w-full rounded-xl border border-[#0f2b46]/10 object-cover" loading="lazy" />
            ))}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild className="bg-[#b22234] font-black text-white hover:bg-[#921b2a]">
            <Link href={`/announcements/${encodeURIComponent(current.id)}`} onClick={dismiss}>شاهد التفاصيل</Link>
          </Button>
          <Button variant="outline" onClick={dismiss} className="font-bold">فهمت</Button>
        </div>
      </div>
    </div>
  )
}
