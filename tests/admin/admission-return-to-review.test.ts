import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Return-to-review guard (Haris 2026-11-13): rejecting a study admission
// hides the whole state-machine buttons block (gated on status !==
// 'REJECTED'), so a rejected card had no way back to review — and the
// supervisor picker (same gate) stayed hidden too. The server already
// allows REJECTED → UNDER_REVIEW; only the UI was missing the path.
// The button below is that path, and nothing else changes: no new API,
// no server change, no supervisor-logic change, service requests excluded.
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const view = () => read('src/components/aact/AdminView.tsx')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('admission return to review', () => {
  test('rejected study cards carry an «إعادة للمراجعة» button outside the hidden buttons block', () => {
    const v = view()
    // Exact button: study admissions only, never staff-owned accounts,
    // only while REJECTED — placed after the CERTIFIED badge, outside the
    // buttons block that hides on REJECTED.
    expect(v).toContain("{isStudyAdmission && !ownerIsStaffAccount && a.status === 'REJECTED' && (")
    expect(v).toContain("onClick={() => setAdmissionStatus(a.id, 'UNDER_REVIEW')}")
    expect(v).toContain('إعادة للمراجعة')
    // The buttons block itself still hides on REJECTED — that is why this
    // button must live outside it, and why it must not be moved inside.
    expect(v).toContain("{!ownerIsStaffAccount && a.status !== 'REJECTED' && a.status !== 'CERTIFIED' && (")
    const buttonAt = v.indexOf('إعادة للمراجعة')
    const blockAt = v.indexOf("{!ownerIsStaffAccount && a.status !== 'REJECTED' && a.status !== 'CERTIFIED' && (")
    const badgeAt = v.indexOf('شهادة دراسية صادرة')
    expect(buttonAt).toBeGreaterThan(badgeAt)
    expect(buttonAt).toBeGreaterThan(blockAt)
    // Exactly two UNDER_REVIEW call sites: «بدء الدراسة» (PENDING) and
    // this return button (REJECTED) — no third path was added.
    expect(count(v, "setAdmissionStatus(a.id, 'UNDER_REVIEW')")).toBe(2)
  })

  test('clicking it PATCHes the admissions endpoint with UNDER_REVIEW', () => {
    const v = view()
    // setAdmissionStatus is the same PATCH the «بدء الدراسة» button uses.
    expect(v).toContain("await api('/api/admin/admissions', { method: 'PATCH', body: JSON.stringify({ id, status }) })")
    expect(v).toContain("const setAdmissionStatus = async (id: string, status: string) => {")
  })

  test('returning to review reopens the supervisor picker with the same supervisor', () => {
    const v = view()
    // The picker gate is unchanged and complementary: it shows exactly
    // when the status is not REJECTED — so UNDER_REVIEW reopens it, and
    // the stored supervisorId (never cleared by a rejection) is still there.
    expect(v).toContain("{isStudyAdmission && !ownerIsStaffAccount && a.status !== 'REJECTED' && a.status !== 'CERTIFIED' && (")
    expect(v).toContain('onValueChange={(v) => assignSupervisor(a.id, v)}')
  })

  test('the server already allows REJECTED → UNDER_REVIEW', () => {
    const route = read('src/app/api/admin/admissions/route.ts')
    expect(route).toContain("} else if (status === 'UNDER_REVIEW') {")
    expect(route).toContain("transitionAllowed = PRE_GATE_STATUSES.includes(FROM) || FROM === 'REJECTED'")
  })
})
