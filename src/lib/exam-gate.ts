import { db } from '@/lib/db'

// بوابة الامتحانات قبل البحث — وفق مسار المنصة الرسمي:
// الطالب ينهي امتحانات الوحدات + امتحاني الفصلين (إن وجدا) ← ثم يُفتح له تسليم بحث التخرج
// الذي يُناقَش لاحقاً عبر غرفة الفيديو كونفرنس.

export interface ExamsGate {
  required: number
  passed: number
  complete: boolean
  missing: { kind: 'UNIT' | 'SEMESTER'; title: string }[]
  hasAnyExam: boolean
}

export async function getExamsGate(userId: string, programId: string | null | undefined): Promise<ExamsGate> {
  const missing: ExamsGate['missing'] = []
  let required = 0
  let passed = 0

  if (!programId) {
    return { required: 0, passed: 0, complete: true, missing: [], hasAnyExam: false }
  }

  // 1) امتحانات الوحدات المقررة (التي تحتوي أسئلة فعلاً)
  const unitExams = await db.exam.findMany({
    where: { unit: { programId }, questions: { some: {} } },
    select: { id: true, title: true },
  })
  for (const ex of unitExams) {
    required++
    const ok = await db.examAttempt.findFirst({
      where: { userId, examId: ex.id, passed: true },
      select: { id: true },
    })
    if (ok) passed++
    else missing.push({ kind: 'UNIT', title: ex.title })
  }

  // 2) امتحانات الفصول الجاهزة للبرنامج
  const semExams = await db.programExam.findMany({
    where: { programId, status: 'READY' },
    select: { id: true, title: true },
  })
  for (const ex of semExams) {
    required++
    const ok = await db.programExamAttempt.findFirst({
      where: { userId, examId: ex.id, passed: true },
      select: { id: true },
    })
    if (ok) passed++
    else missing.push({ kind: 'SEMESTER', title: ex.title })
  }

  return {
    required,
    passed,
    complete: missing.length === 0,
    missing,
    hasAnyExam: required > 0,
  }
}
