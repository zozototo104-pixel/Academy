import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Mobile-overflow guard pins (390px, Haris's phone 2026-11-12):
// the admin books + system tabs scrolled horizontally because Radix
// SelectTrigger buttons carry their full selected label as intrinsic
// min-content width, and their grid items had no min-w-0 — so the grid
// blew past the viewport and the whole tab (inputs included) was cut
// on the left. a1cdee5c fixed only the F() text inputs; SelectF and the
// book-workspace header selects were left behind.
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('admin mobile overflow guard', () => {
  test('books and system tabs clip horizontal overflow', () => {
    const view = read('src/components/aact/AdminView.tsx')
    expect(view).toContain('<TabsContent value="books" className="w-full min-w-0 max-w-full overflow-x-hidden">')
    expect(view).toContain('<TabsContent value="system" className="w-full min-w-0 max-w-full overflow-x-hidden">')
    expect(view).not.toContain('<TabsContent value="books">')
    expect(view).not.toContain('<TabsContent value="system">')
  })

  test('system-tab SelectF shrinks like F()', () => {
    const tab = read('src/components/aact/AdminSystemTab.tsx')
    expect(tab).toContain('<div key={k} className="min-w-0 space-y-1">')
    expect(tab).toContain('<Label className="block max-w-full break-words text-[11px] font-black text-[#0f2b46]">{label}</Label>')
    expect(tab).toContain('<SelectTrigger className="h-9 min-w-0 w-full max-w-full bg-white text-sm" dir="ltr">')
  })

  test('book-workspace header selects shrink', () => {
    const books = read('src/components/aact/AdminBooks.tsx')
    expect(books.match(/<div className="min-w-0 space-y-1\.5">/g)?.length).toBe(2)
    expect(books.match(/<SelectTrigger className="h-11 min-w-0 w-full max-w-full text-sm font-bold">/g)?.length).toBe(2)
  })

  test('outline and debug rows break long unbroken strings', () => {
    const books = read('src/components/aact/AdminBooks.tsx')
    expect(books).toContain('<p key={section.id} dir="rtl" className="mt-1 break-words text-[11px]">')
    expect(books).toContain('<div key={section.id} dir="rtl" className="mt-1 break-words">')
    expect(books).toContain('className="break-words rounded bg-white p-2 text-[10px] leading-5 text-slate-700"')
  })

  test('email-change dialog keeps its mobile margins and shrinks its select', () => {
    const view = read('src/components/aact/AdminView.tsx')
    // The email dialog is the only one that must not set a base max-w:
    // max-w-md would override the base max-w-[calc(100%-2rem)] and push
    // the dialog past a 390px viewport (Haris's phone 2026-11-13).
    expect(view).toContain('<DialogContent dir="rtl" className="sm:max-w-md">')
    expect(view).not.toContain('<DialogContent dir="rtl" className="max-w-md">')
    expect(view).toContain('<SelectTrigger className="min-w-0 w-full max-w-full"><SelectValue /></SelectTrigger>')
    expect(view).toContain('<span className="break-all">{emailChangeStudent?.email}</span>')
    // The trigger alone is not enough: the dialog is a grid, so its direct
    // child (the space-y-3 body) also needs min-w-0, or the grid track is
    // sized by the trigger's nowrap min-content and everything still spills
    // left (proven by the 390px render: 613px track without it, 308px with it).
    expect(view).toContain('<div className="min-w-0 space-y-3">')
  })

  test('email-change close is deferred one frame on iOS Safari', () => {
    const view = read('src/components/aact/AdminView.tsx')
    // Hardening, not a proven fix: closing in the same commit as the
    // toast+blur races Radix's unmount on iOS Safari (removeChild crash
    // screen). The real proof is retrying the action on a phone.
    expect(view).toContain('requestAnimationFrame(() => setEmailChangeStudent(null))')
    expect(view).toContain("typeof requestAnimationFrame === 'function'")
  })
})
