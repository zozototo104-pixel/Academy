export function cleanAdminQuery(value: unknown, max = 160) {
  return String(value || '').trim().slice(0, max)
}

export function parseAdminPagination(searchParams: URLSearchParams, defaults: { pageSize?: number; maxPageSize?: number } = {}) {
  const pageSizeDefault = defaults.pageSize || 25
  const maxPageSize = defaults.maxPageSize || 100
  const rawPage = Number(searchParams.get('page') || '1')
  const rawPageSize = Number(searchParams.get('pageSize') || String(pageSizeDefault))
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(maxPageSize, Math.max(1, Math.floor(rawPageSize))) : pageSizeDefault
  const skip = (page - 1) * pageSize
  return { page, pageSize, skip, take: pageSize }
}

export function adminPaginationMeta(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
  }
}
