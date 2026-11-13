import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Top-level «محاضراتي» main section (Haris 2026-11-13, with his screenshot
// of the student-detail tab): the supervisor's lectures/meetings cover ALL
// his students — the per-student «محاضراتي» tab already renders
// <AdminLectures surface="supervisor" /> with NO student filter — so the
// tab belongs on the main page too, next to «طلابي والمتابعة» and
// «المحتوى والوحدات». This adds a fourth main-section button + render
// branch reusing the SAME component with the SAME surface prop. No new API,
// no scope change, no new props. The per-student tab is NOT removed or
// moved — it stays exactly as it is.
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const view = () => read('src/components/aact/SupervisorView.tsx')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

const MAIN_BUTTONS = [
  "{ key: 'students', label: 'طلابي والمتابعة' },",
  "{ key: 'lectures', label: 'محاضراتي' },",
  "{ key: 'content', label: 'المحتوى والوحدات' },",
  "{ key: 'review', label: 'مراجعة الدرجات والالتماسات' },",
]

describe('supervisor lectures main section', () => {
  test('the main-section buttons are exactly four, in order, with the lectures button second', () => {
    const v = view()
    // Exactly four entries in the main-section buttons array.
    expect(count(v, "{ key: 'students', label: 'طلابي والمتابعة' },")).toBe(1)
    expect(count(v, "{ key: 'lectures', label: 'محاضراتي' },")).toBe(1)
    expect(count(v, "{ key: 'content', label: 'المحتوى والوحدات' },")).toBe(1)
    expect(count(v, "{ key: 'review', label: 'مراجعة الدرجات والالتماسات' },")).toBe(1)
    // Order: students, lectures, content, review.
    const at = MAIN_BUTTONS.map((line) => v.indexOf(line))
    at.forEach((pos) => expect(pos).toBeGreaterThan(-1))
    expect(at[0]).toBeLessThan(at[1])
    expect(at[1]).toBeLessThan(at[2])
    expect(at[2]).toBeLessThan(at[3])
    // The button rendering is shared — the new button uses the same
    // styling and active/inactive states as the other three.
    expect(v).toContain("onClick={() => setMainSection(s.key)}")
    expect(v).toContain("className={`rounded-2xl px-4 py-2 text-xs font-black transition ${mainSection === s.key ? 'bg-[#0f2b46] text-[#e0b83a] shadow' : 'border border-slate-200 bg-white text-slate-600 hover:border-[#c9a227]/60'}`}")
  })

  test('the lectures branch renders the same component with the same surface prop, top-level', () => {
    const v = view()
    expect(v).toContain("{mainSection === 'lectures' && <AdminLectures surface=\"supervisor\" />}")
    // Exactly two supervisor-surface renders in the file: the per-student
    // tab and the new top-level branch — no other AdminLectures usage.
    expect(count(v, '<AdminLectures surface="supervisor" />')).toBe(2)
    // Top-level: the branch sits with the content/review branches, after
    // the students block closes and before the content branch.
    const studentsClose = v.indexOf("{mainSection === 'students' && (<>")
    const lecturesBranch = v.indexOf("{mainSection === 'lectures' && <AdminLectures surface=\"supervisor\" />}")
    const contentBranch = v.indexOf("{mainSection === 'content' && <SupervisorContentTab />}")
    const reviewBranch = v.indexOf("{mainSection === 'review' && <SupervisorGradeReviewTab focus={reviewFocus} />}")
    expect(studentsClose).toBeGreaterThan(-1)
    expect(lecturesBranch).toBeGreaterThan(studentsClose)
    expect(contentBranch).toBeGreaterThan(lecturesBranch)
    expect(reviewBranch).toBeGreaterThan(contentBranch)
  })

  test('the main-section state type includes lectures', () => {
    const v = view()
    expect(v).toContain("const [mainSection, setMainSection] = useState<'students' | 'lectures' | 'content' | 'review'>('students')")
  })

  test('the per-student محاضراتي tab is still present and unchanged', () => {
    const v = view()
    // Trigger inside the student card's TabsList.
    expect(v).toContain('<TabsTrigger value="lectures" className="text-[11px] font-black"><Video className="ml-1 h-3.5 w-3.5" /> محاضراتي</TabsTrigger>')
    // Content inside the student card's TabsContent.
    expect(v).toContain('<TabsContent value="lectures" className="space-y-4">')
    // Exactly one per-student trigger and one per-student content block.
    expect(count(v, '<TabsTrigger value="lectures"')).toBe(1)
    expect(count(v, '<TabsContent value="lectures"')).toBe(1)
    // The per-student render is the plain component (no student filter).
    const contentAt = v.indexOf('<TabsContent value="lectures" className="space-y-4">')
    const renderAt = v.indexOf('<AdminLectures surface="supervisor" />', contentAt)
    expect(renderAt).toBeGreaterThan(contentAt)
  })
})
