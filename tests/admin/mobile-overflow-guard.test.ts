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
    expect(tab).toContain('<SelectTrigger className="min-h-11 h-auto min-w-0 w-full max-w-full overflow-hidden whitespace-normal bg-white py-2 text-sm" dir="rtl">')
    expect(tab).toContain('<SelectValue className="sr-only" placeholder="اختر" />')
    expect(tab).toContain("normalizedOptions.find((opt) => opt.value === current)?.label || 'اختر'")
    expect(tab).toContain('className="min-w-0 whitespace-normal break-words"')
    expect(tab).toContain('className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-3 sm:grid-cols-2 sm:p-4"')
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

  test('shared selects and platform dialogs are constrained to the mobile viewport', () => {
    const select = read('src/components/ui/select.tsx')
    const dialog = read('src/components/aact/AdminActionDialog.tsx')
    expect(select).toContain('w-fit min-w-0 max-w-full')
    expect(select).toContain('*:data-[slot=select-value]:min-w-0')
    expect(select).toContain('*:data-[slot=select-value]:overflow-hidden')
    expect(select).toContain('max-w-[calc(100vw-1rem)]')
    expect(select).toContain('whitespace-normal break-words')
    expect(dialog).toContain('max-w-[calc(100%-2rem)]')
    expect(dialog).toContain('sm:max-w-md')
    expect(dialog).not.toContain('gap-0 max-w-md')
  })

  test('platform screens no longer use browser-owned confirmation or prompt windows', () => {
    const files = [
      'src/components/aact/AdminView.tsx',
      'src/components/aact/AdminLectures.tsx',
      'src/components/aact/AdminAnnouncementsTab.tsx',
      'src/components/aact/AdminStudyScheduleTab.tsx',
      'src/components/aact/AdminRepresentativesTab.tsx',
      'src/components/aact/AdminLegacyGraduatesTab.tsx',
      'src/components/aact/ExamView.tsx',
      'src/components/aact/AIChatView.tsx',
      'src/components/aact/SupervisorContentTab.tsx',
      'src/app/representatives/onboarding/[token]/page.tsx',
    ]
    for (const path of files) {
      const source = read(path)
      expect(source, path).not.toMatch(/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/)
    }
    // AdminExtras retains a local function named confirm(p), not the browser
    // global. Its certificate prompts must still use the platform dialog.
    const certificates = read('src/components/aact/AdminExtras.tsx')
    expect(certificates).not.toContain('window.prompt(')
    expect(certificates).toContain("const { promptAction, dialog: actionDialog } = useAdminActionDialog()")
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
