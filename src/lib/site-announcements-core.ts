export type SiteAnnouncementDisplay = 'TICKER' | 'PULSE'

export type SiteAnnouncement = {
  id: string
  title: string
  summary: string
  body: string
  display: SiteAnnouncementDisplay
  active: boolean
  startsAt?: string | null
  endsAt?: string | null
  createdAt: string
  updatedAt: string
}

export type SiteAnnouncementInput = {
  title?: unknown
  summary?: unknown
  body?: unknown
  display?: unknown
  active?: unknown
  startsAt?: unknown
  endsAt?: unknown
}

const DISPLAY_VALUES = new Set<SiteAnnouncementDisplay>(['TICKER', 'PULSE'])

export function canManageSiteAnnouncements(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === 'ADMIN'
}

function text(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function longText(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function assertPlain(label: string, value: string) {
  if (/[<>]/.test(value)) throw new Error(`${label} يجب أن يكون نصاً عادياً بدون HTML`)
}

function normalizeDate(value: unknown, label: string): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} غير صالح`)
  return date.toISOString()
}

function normalizeDisplay(value: unknown): SiteAnnouncementDisplay {
  const display = String(value || 'TICKER').trim().toUpperCase()
  if (!DISPLAY_VALUES.has(display as SiteAnnouncementDisplay)) throw new Error('طريقة العرض غير صالحة')
  return display as SiteAnnouncementDisplay
}

export function parseSiteAnnouncementsValue(value: unknown): SiteAnnouncement[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => normalizeStoredAnnouncement(item))
      .filter((item): item is SiteAnnouncement => !!item)
  } catch {
    return []
  }
}

function normalizeStoredAnnouncement(item: unknown): SiteAnnouncement | null {
  if (!item || typeof item !== 'object') return null
  const source = item as Record<string, unknown>
  const id = text(source.id)
  const title = text(source.title)
  const summary = text(source.summary)
  const body = longText(source.body)
  const displayRaw = String(source.display || 'TICKER').trim().toUpperCase()
  if (!id || !title || !summary || !DISPLAY_VALUES.has(displayRaw as SiteAnnouncementDisplay)) return null
  return {
    id,
    title: title.slice(0, 120),
    summary: summary.slice(0, 200),
    body: body.slice(0, 5000),
    display: displayRaw as SiteAnnouncementDisplay,
    active: source.active === true,
    startsAt: typeof source.startsAt === 'string' && source.startsAt.trim() ? new Date(source.startsAt).toISOString() : null,
    endsAt: typeof source.endsAt === 'string' && source.endsAt.trim() ? new Date(source.endsAt).toISOString() : null,
    createdAt: typeof source.createdAt === 'string' && source.createdAt.trim() ? new Date(source.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt.trim() ? new Date(source.updatedAt).toISOString() : new Date().toISOString(),
  }
}

export function validateAnnouncementInput(input: SiteAnnouncementInput, existing?: SiteAnnouncement): SiteAnnouncement {
  const now = new Date().toISOString()
  const title = 'title' in input ? text(input.title) : existing?.title || ''
  const summary = 'summary' in input ? text(input.summary) : existing?.summary || ''
  const body = 'body' in input ? longText(input.body) : existing?.body || ''
  const display = 'display' in input ? normalizeDisplay(input.display) : existing?.display || 'TICKER'
  const active = 'active' in input ? input.active === true || String(input.active).toLowerCase() === 'true' : existing?.active ?? true
  const startsAt = 'startsAt' in input ? normalizeDate(input.startsAt, 'تاريخ البداية') : existing?.startsAt ?? null
  const endsAt = 'endsAt' in input ? normalizeDate(input.endsAt, 'تاريخ النهاية') : existing?.endsAt ?? null

  if (!title) throw new Error('عنوان الإعلان مطلوب')
  if (!summary) throw new Error('نص الشريط مطلوب')
  if (title.length > 120) throw new Error('عنوان الإعلان يجب ألا يتجاوز 120 حرفاً')
  if (summary.length > 200) throw new Error('نص الشريط يجب ألا يتجاوز 200 حرف')
  if (body.length > 5000) throw new Error('تفاصيل الإعلان يجب ألا تتجاوز 5000 حرف')
  assertPlain('عنوان الإعلان', title)
  assertPlain('نص الشريط', summary)
  assertPlain('تفاصيل الإعلان', body)
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) throw new Error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية')

  return {
    id: existing?.id || crypto.randomUUID(),
    title,
    summary,
    body,
    display,
    active,
    startsAt,
    endsAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
}

export function filterActiveSiteAnnouncements(items: SiteAnnouncement[], nowInput: Date | string = new Date()): SiteAnnouncement[] {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput)
  const time = now.getTime()
  if (Number.isNaN(time)) return []
  return items.filter((item) => {
    if (!item.active) return false
    if (item.startsAt && new Date(item.startsAt).getTime() > time) return false
    if (item.endsAt && new Date(item.endsAt).getTime() < time) return false
    return true
  })
}
