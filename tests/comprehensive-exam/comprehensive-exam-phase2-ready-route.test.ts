// Comprehensive exam phase 2 — READY list route (candidate picker source).
// The picker must list programs DYNAMICALLY: only programs with a READY
// exam, titles taken from the database — nothing hardcoded. These tests
// prove that: a DRAFT exam never appears, and renaming a program in the
// DB changes what the picker returns. The seed uses the owner's single
// program (admin-created data, one name — not two) as the fixture.
import { describe, expect, mock, test } from 'bun:test'

let programs: any[] = []
let exams: any[] = []

const fakeDb: any = {
  comprehensiveExam: {
    findMany: async ({ where }: any = {}) => {
      const rows = exams.filter((e) => !where?.status || e.status === where.status)
      return rows.map((e) => ({
        ...e,
        program: programs.find((p) => p.id === e.programId) || null,
      }))
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))

const readyRoute = await import('../../src/app/api/comprehensive-exams/ready/route')

function seed() {
  programs = [
    { id: 'prog-certs-equiv', titleAr: 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية', titleEn: 'Professional Certificates & Professional Experience Equivalency' },
    { id: 'prog-draft', titleAr: 'برنامج مسودة فقط', titleEn: 'Draft only' },
  ]
  exams = [
    { id: 'exam-1', programId: 'prog-certs-equiv', title: 'الامتحان الشامل — برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية', status: 'READY', durationMin: 120, passScore: 60, updatedAt: new Date() },
    { id: 'exam-3', programId: 'prog-draft', title: 'الامتحان الشامل — برنامج مسودة فقط', status: 'DRAFT', durationMin: 120, passScore: 60, updatedAt: new Date() },
  ]
}

describe('READY list (candidate program picker)', () => {
  test('lists only programs with a READY exam, with titles from the database', async () => {
    seed()
    const res = await readyRoute.GET(new Request('http://localhost/api/comprehensive-exams/ready') as any)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.exams.length).toBe(1)
    const titles = data.exams.map((e: any) => e.programTitle)
    expect(titles).toContain('برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية')
    expect(titles).not.toContain('برنامج مسودة فقط')
    expect(data.exams.map((e: any) => e.programId)).toEqual(['prog-certs-equiv'])
  })
  test('a program renamed in the database appears renamed — nothing is hardcoded', async () => {
    seed()
    programs[0].titleAr = 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية (محدّث)'
    const res = await readyRoute.GET(new Request('http://localhost/api/comprehensive-exams/ready') as any)
    const data = await res.json()
    expect(data.exams.map((e: any) => e.programTitle)).toContain('برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية (محدّث)')
    expect(data.exams.map((e: any) => e.programTitle)).not.toContain('برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية')
  })
  test('no READY exam means an empty picker', async () => {
    seed()
    exams.forEach((e) => {
      e.status = 'DRAFT'
    })
    const res = await readyRoute.GET(new Request('http://localhost/api/comprehensive-exams/ready') as any)
    const data = await res.json()
    expect(data.exams).toEqual([])
  })
  test('no questions or answers leak through the picker', async () => {
    seed()
    const res = await readyRoute.GET(new Request('http://localhost/api/comprehensive-exams/ready') as any)
    const body = await res.text()
    expect(body).not.toContain('correctAnswer')
    expect(body).not.toContain('question')
  })
})
