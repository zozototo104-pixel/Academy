import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getActiveSiteAnnouncementsCached } from '@/lib/site-announcements'

export default async function AnnouncementDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolved = await params
  const id = decodeURIComponent(resolved.id || '')
  const announcements = await getActiveSiteAnnouncementsCached()
  const announcement = announcements.find((item) => item.id === id)
  if (!announcement) notFound()
  const date = new Date(announcement.updatedAt || announcement.createdAt)

  return (
    <main className="min-h-screen bg-[#eef0f5] px-4 py-10 text-[#0f2b46]">
      <article className="mx-auto max-w-3xl rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl sm:p-9">
        <Link href="/" className="text-xs font-black text-[#b22234] hover:underline">العودة للموقع</Link>
        <div className="mt-5 flex flex-wrap items-center gap-2 text-[11px] font-black text-slate-500">
          <span className="rounded-full bg-[#fffaf0] px-3 py-1 text-[#a8841a]">إعلان</span>
          <time dateTime={date.toISOString()}>{date.toLocaleDateString('ar')}</time>
        </div>
        <h1 className="mt-4 text-2xl font-black leading-relaxed sm:text-4xl">{announcement.title}</h1>
        <p className="mt-3 rounded-2xl bg-[#fffaf0] p-4 text-sm font-bold leading-8 text-[#0f2b46]">{announcement.summary}</p>
        {announcement.body && (
          <div className="mt-6 whitespace-pre-wrap text-sm font-medium leading-9 text-slate-700 sm:text-base">
            {announcement.body}
          </div>
        )}
      </article>
    </main>
  )
}
