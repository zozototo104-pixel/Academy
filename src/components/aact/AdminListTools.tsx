'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

export const ADMIN_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export function normalizeSearch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim()
}

export function matchesAdminSearch(query: string, fields: Array<unknown>): boolean {
  const q = normalizeSearch(query)
  if (!q) return true
  return fields.some((field) => normalizeSearch(field).includes(q))
}

export function safePage(total: number, pageSize: number, page: number): number {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  return Math.min(Math.max(1, page || 1), pages)
}

export function pageItems<T>(items: T[], page: number, pageSize: number): T[] {
  const current = safePage(items.length, pageSize, page)
  const start = (current - 1) * pageSize
  return items.slice(start, start + pageSize)
}

interface StatusOption {
  value: string
  label: string
}

interface AdminListToolbarProps {
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  status?: string
  onStatusChange?: (value: string) => void
  statusOptions?: StatusOption[]
  pageSize: number
  onPageSizeChange: (value: number) => void
  total: number
  filtered: number
  label?: string
  extra?: ReactNode
}

export function AdminListToolbar({
  search,
  onSearchChange,
  searchPlaceholder = 'ابحث بالاسم أو البريد أو الرقم...',
  status,
  onStatusChange,
  statusOptions,
  pageSize,
  onPageSizeChange,
  total,
  filtered,
  label = 'سجل',
  extra,
}: AdminListToolbarProps) {
  return (
    <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-3 shadow-sm">
      <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_180px_150px_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-10 rounded-xl bg-slate-50 pr-9 text-sm font-bold"
          />
        </div>
        {statusOptions && onStatusChange ? (
          <Select value={status || 'ALL'} onValueChange={onStatusChange}>
            <SelectTrigger className="h-10 rounded-xl bg-slate-50 font-bold"><SelectValue /></SelectTrigger>
            <SelectContent>
              {statusOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : <div className="hidden lg:block" />}
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="h-10 rounded-xl bg-slate-50 font-bold"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ADMIN_PAGE_SIZE_OPTIONS.map((size) => <SelectItem key={size} value={String(size)}>عرض {size}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center justify-between gap-2 rounded-xl bg-[#f7edd0]/60 px-3 py-2 text-xs font-black text-[#0f2b46] lg:justify-center">
          <span>{filtered} / {total}</span>
          <span className="text-slate-500">{label}</span>
        </div>
      </div>
      {extra ? <div className="mt-2">{extra}</div> : null}
    </div>
  )
}

interface AdminPagerProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  label?: string
}

export function AdminPager({ page, pageSize, total, onPageChange, label = 'نتيجة' }: AdminPagerProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const current = safePage(total, pageSize, page)
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1
  const end = Math.min(total, current * pageSize)
  if (total <= pageSize) {
    return (
      <div className="rounded-xl bg-slate-50 px-3 py-2 text-center text-xs font-bold text-slate-500">
        عرض {total} {label}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-[#0f2b46]/10 bg-white px-3 py-2 sm:flex-row">
      <div className="text-xs font-bold text-slate-500">عرض {start}–{end} من {total} {label}</div>
      <div className="flex items-center gap-1" dir="ltr">
        <Button type="button" size="sm" variant="outline" disabled={current <= 1} onClick={() => onPageChange(1)} className="h-8 w-8 p-0"><ChevronsLeft className="h-4 w-4" /></Button>
        <Button type="button" size="sm" variant="outline" disabled={current <= 1} onClick={() => onPageChange(current - 1)} className="h-8 w-8 p-0"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="min-w-20 rounded-lg bg-[#0f2b46] px-3 py-1.5 text-center text-xs font-black text-[#e0b83a]">{current} / {pages}</span>
        <Button type="button" size="sm" variant="outline" disabled={current >= pages} onClick={() => onPageChange(current + 1)} className="h-8 w-8 p-0"><ChevronRight className="h-4 w-4" /></Button>
        <Button type="button" size="sm" variant="outline" disabled={current >= pages} onClick={() => onPageChange(pages)} className="h-8 w-8 p-0"><ChevronsRight className="h-4 w-4" /></Button>
      </div>
    </div>
  )
}
