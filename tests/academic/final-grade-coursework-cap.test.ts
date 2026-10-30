import { describe, expect, mock, test } from 'bun:test'

// lib/final-grade يستورد db افتراضياً؛ الاختبار يحقن عميلاً وهمياً دائماً.
mock.module('@/lib/db', () => ({ db: {} }))

const { calculateFinalGrade } = await import('@/lib/final-grade')

// ---------------------------------------------------------------------------
// سقف أعمال السنة (تدقيق ٢٠٢٦-١٠-٣٠، الوحدة ٤): تسليم امتحان البرنامج يخزن
// العلامة مقيدة بالسقف (min(الخام، maxExamScore)) ويحفظ الخام في
// rawScoreBeforeCourseworkCap للشفافية فقط. حساب الشهادة كان يعيد حساب
// النسبة من الإجابات الخام ويتجاوز السقف بصمت — طالب خامُه ٩٥ وسقفه ٧٠
// كان يُعتمد بـ٩٥. القاعدة: الشهادة تعتمد العلامة المخزنة دائماً، وفرع
// الطعن المراجَع يبقى على finalScore.
// ---------------------------------------------------------------------------

function fakeClient(programAttempt: any) {
  return {
    program: { findUnique: async () => ({ category: 'DIPLOMA' }) },
    exam: {
      findMany: async () => [
        { id: 'unit-exam-1', title: 'اختبار وحدة', passScore: 50, unit: { title: 'الوحدة الأولى' }, _count: { questions: 4 } },
      ],
    },
    examAttempt: {
      findMany: async () => [{ score: 80, answers: [{ points: 80, maxPoints: 100 }] }],
    },
    programExam: {
      findMany: async () => [{ id: 'pex-1', title: 'الامتحان النهائي', semester: null, passScore: 50 }],
    },
    programExamAttempt: { findMany: async () => [programAttempt] },
    programAssignment: { findMany: async () => [{ id: 'a-1', title: 'واجب', points: 100 }] },
    assignmentSubmission: { findUnique: async () => ({ status: 'GRADED', score: 100 }) },
    thesisSubmission: { findFirst: async () => null },
  } as any
}

async function grade(programAttempt: any) {
  return calculateFinalGrade({ userId: 'student-1', programId: 'prog-1', client: fakeClient(programAttempt) })
}

function finalExamComponent(result: any) {
  return result.components.find((c: any) => c.key === 'final_exam')
}

describe('حساب الشهادة يحترم سقف أعمال السنة', () => {
  test('طالب مقيد بالسقف: مكوّن الامتحان النهائي = العلامة المخزنة ٧٠ لا الخام ٩٥', async () => {
    const result = await grade({
      score: 70, // المخزنة بعد تطبيق سقف maxExamScore=70
      finalScore: null,
      appealStatus: null,
      answers: [{ points: 95, maxPoints: 100 }], // الخام ٩٥
    })
    expect(finalExamComponent(result)?.score).toBe(70)
  })

  test('المجموع النهائي يُبنى على المقيدة: (٨٠×٢٠ + ١٠٠×٢٠ + ٧٠×٦٠) ÷ ١٠٠ = ٧٨', async () => {
    const result = await grade({
      score: 70,
      finalScore: null,
      appealStatus: null,
      answers: [{ points: 95, maxPoints: 100 }],
    })
    expect(result.score).toBe(78)
  })

  test('طالب بلا سقف (كمّل أعماله): علامته الخام كاملة كما هي', async () => {
    const result = await grade({
      score: 95,
      finalScore: null,
      appealStatus: null,
      answers: [{ points: 95, maxPoints: 100 }],
    })
    expect(finalExamComponent(result)?.score).toBe(95)
  })

  test('طعن مرجَّع: تُعتمد علامة المراجعة النهائية ٨٨', async () => {
    const result = await grade({
      score: 70,
      finalScore: 88,
      appealStatus: 'REVIEWED',
      answers: [{ points: 95, maxPoints: 100 }],
    })
    expect(finalExamComponent(result)?.score).toBe(88)
  })
})
