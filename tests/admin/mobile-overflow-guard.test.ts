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
    // SelectF renders its label exactly once, from the manual span: the
    // sr-only <SelectValue /> that used to sit beside it rendered visibly
    // on Haris's phone (2026-11-14), duplicating every SelectF label
    // (provider, voices, Live models, policies). The only <SelectValue />
    // left in the tab is the custom-provider free-model picker, which has
    // no manual span and renders its value once by design.
    expect(tab.match(/<SelectValue/g)?.length).toBe(1)
    expect(tab).not.toContain('<SelectValue className="sr-only"')
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

  test('student + supervisor pages break long unbroken tokens on mobile (Haris 2026-11-14)', () => {
    // The 42-char admission reference (AACT-2026- + 32 hex, one unbreakable
    // token) and long tokens pasted in messages/answers/abstracts blew past
    // the 320–430px viewport. Every fix below is one class: min-w-0 on the
    // flex item that must shrink, break-all on the token itself, break-words
    // on the wrapping text. No layout, API or logic change.
    const messages = read('src/components/aact/StudentAdminMessages.tsx')
    expect(messages).toContain('<span className="min-w-0 flex-1">')
    expect(messages).toContain('<span className="block break-words font-bold">طلب <span className="break-all">{c.admission.reference}</span>')
    expect(messages).toContain('<h3 className="min-w-0 break-words font-bold">')
    expect(messages).toContain('<p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>')
    const apply = read('src/components/aact/ApplyView.tsx')
    expect(apply).toContain('<div className="mx-auto mt-4 w-fit max-w-full rounded-xl border border-emerald-200 bg-white px-6 py-4">')
    expect(apply).toContain('<div className="mt-1 break-all font-mono text-lg font-black text-[#0f2b46] sm:text-2xl" dir="ltr">{done.reference}</div>')
    expect(apply).toContain('<p className="break-all font-mono text-sm font-black text-[#e0b83a] sm:text-lg" dir="ltr">{app.reference}</p>')
    expect(apply).toContain('<div className="break-all font-mono text-xs font-bold text-slate-500" dir="ltr">{tracked.reference}</div>')
    const cert = read('src/components/aact/CertificateDialog.tsx')
    expect(cert).toContain('<p className="break-all font-mono text-[10px] font-bold text-[#0f2b46]" dir="ltr">{certificate.serial}</p>')
    const exam = read('src/components/aact/ExamView.tsx')
    expect(exam).toContain('<span className="whitespace-pre-wrap break-words">{r.studentAnswer}</span>')
    expect(exam).toContain('<span className="mt-1 block break-words">')
    // The proctor PIP floats over the exam nav buttons; it folds to a chip
    // instead. The video element itself never unmounts, so capture keeps
    // reading from it in both states.
    expect(exam).toContain('proctorPipCollapsed')
    expect(exam).toContain("aria-label=\"طي نافذة المراقبة\"")
    const chat = read('src/components/aact/AIChatView.tsx')
    expect(chat).toContain('<div className="whitespace-pre-wrap break-words">{m.content}</div>')
    expect(chat).toContain('grid-cols-5 items-center gap-2 sm:gap-3')
    expect(chat).toContain('flex h-12 w-12 items-center justify-center rounded-full border sm:h-14 sm:w-14')
    const sup = read('src/components/aact/SupervisorView.tsx')
    expect(sup).toContain('max-w-[85%] break-words rounded-2xl')
    const thesis = read('src/components/aact/StudentThesisTab.tsx')
    expect(thesis).toContain('whitespace-pre-wrap break-words text-xs font-semibold leading-relaxed text-slate-600')
    expect(thesis).toContain('whitespace-pre-wrap break-words text-xs font-semibold leading-relaxed text-slate-700')
    const unit = read('src/components/aact/UnitView.tsx')
    expect(unit).toContain('<p className="break-words text-sm leading-loose text-slate-700">{section.body}</p>')
    const dash = read('src/components/aact/DashboardView.tsx')
    expect(dash).toContain('<p className="break-words text-sm font-black text-[#0f2b46]">{n.title}</p>')
    expect(dash).toContain('<p className="mt-1 break-all font-mono text-[9px] font-bold text-slate-400" dir="ltr">{mc.badgeCode}</p>')
    const extras = read('src/components/aact/DashboardExtras.tsx')
    expect(extras).toContain("className='min-w-0 break-all font-mono text-base font-black text-[#0f2b46]'")
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
