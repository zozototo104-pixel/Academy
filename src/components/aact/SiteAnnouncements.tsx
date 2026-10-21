import Link from 'next/link'
import { getActiveSiteAnnouncementsCached } from '@/lib/site-announcements'

function shortTitle(title: string) {
  return title.length > 38 ? `${title.slice(0, 35)}...` : title
}

export async function SiteAnnouncements() {
  const announcements = await getActiveSiteAnnouncementsCached().catch(() => [])
  if (!announcements.length) return null

  const ticker = announcements.filter((item) => item.display === 'TICKER')
  const pulse = announcements.filter((item) => item.display === 'PULSE')

  return (
    <div className="site-announcements-shell" dir="rtl">
      <style>{`
        .site-announcements-shell {
          position: relative;
          z-index: 45;
        }
        body:has([data-aact-admin-view]) .site-announcements-shell {
          display: none;
        }
        .site-announcements-ticker {
          height: 32px;
          overflow: hidden;
          border-bottom: 1px solid rgba(15, 43, 70, 0.08);
          background: #fffaf0;
          color: #0f2b46;
        }
        .site-announcements-ticker-track {
          display: flex;
          align-items: center;
          gap: 2rem;
          width: max-content;
          min-width: 100%;
          height: 32px;
          white-space: nowrap;
          animation: aact-announcement-rtl 32s linear infinite;
        }
        .site-announcements-ticker:hover .site-announcements-ticker-track,
        .site-announcements-ticker:active .site-announcements-ticker-track {
          animation-play-state: paused;
        }
        .site-announcements-ticker-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding-inline: 0.75rem;
          font-size: 11px;
          font-weight: 900;
          color: #0f2b46;
          text-decoration: none;
        }
        .site-announcements-pulse-list {
          position: fixed;
          left: 14px;
          bottom: 96px;
          z-index: 44;
          display: flex;
          max-width: min(260px, calc(100vw - 28px));
          flex-direction: column;
          gap: 0.45rem;
          pointer-events: none;
        }
        .site-announcements-pulse-link {
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          width: fit-content;
          max-width: 100%;
          border: 1px solid rgba(178, 34, 52, 0.18);
          border-radius: 999px;
          background: rgba(255, 250, 240, 0.96);
          box-shadow: 0 10px 28px rgba(15, 43, 70, 0.12);
          padding: 0.42rem 0.72rem;
          color: #0f2b46;
          font-size: 11px;
          font-weight: 900;
          text-decoration: none;
          backdrop-filter: blur(10px);
        }
        .site-announcements-pulse-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #b22234;
          box-shadow: 0 0 0 0 rgba(178, 34, 52, 0.45);
          animation: aact-announcement-pulse 1.45s ease-out infinite;
        }
        @keyframes aact-announcement-rtl {
          from { transform: translateX(100%); }
          to { transform: translateX(-100%); }
        }
        @keyframes aact-announcement-pulse {
          0% { box-shadow: 0 0 0 0 rgba(178, 34, 52, 0.45); }
          70% { box-shadow: 0 0 0 9px rgba(178, 34, 52, 0); }
          100% { box-shadow: 0 0 0 0 rgba(178, 34, 52, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .site-announcements-ticker-track,
          .site-announcements-pulse-dot {
            animation: none;
          }
          .site-announcements-ticker-track {
            transform: none;
          }
        }
        @media (max-width: 640px) {
          .site-announcements-pulse-list {
            bottom: 84px;
            left: 10px;
          }
        }
      `}</style>
      {ticker.length > 0 && (
        <div className="site-announcements-ticker" aria-label="إعلانات الأكاديمية">
          <div className="site-announcements-ticker-track">
            {ticker.map((item) => (
              <Link key={item.id} href={`/announcements/${encodeURIComponent(item.id)}`} className="site-announcements-ticker-link">
                <span aria-hidden="true">📢</span>
                <span>{item.summary}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {pulse.length > 0 && (
        <div className="site-announcements-pulse-list" aria-label="إعلانات مهمة">
          {pulse.slice(0, 3).map((item) => (
            <Link key={item.id} href={`/announcements/${encodeURIComponent(item.id)}`} className="site-announcements-pulse-link">
              <span aria-hidden="true">📢</span>
              <span className="site-announcements-pulse-dot" aria-hidden="true" />
              <span>{shortTitle(item.title)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
