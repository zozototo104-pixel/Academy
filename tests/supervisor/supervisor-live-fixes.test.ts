import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// إصلاحات تجربة المشرف المباشرة (بعد اختبار Haris على الإنتاج):
// (1) زر «فتح بطاقة الطالب» كان يطابق برقم قبول قد لا يكون قبول التعيين فيفشل بصمت.
// (2) الاتصال الصوتي كان يعلّق على «جارٍ إنشاء الاتصال» بلا مهلة عند فشل ICE.
// (3) اختبارات الطالب المسلّمة لم يكن لها طريق نحو مراجعة الدرجات.
const root = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const board = read('src/components/aact/SupervisorFollowUpBoard.tsx')
const view = read('src/components/aact/SupervisorView.tsx')
const gradeTab = read('src/components/aact/SupervisorGradeReviewTab.tsx')
const voice = read('src/components/aact/SupervisorLiveVoiceCall.tsx')
const studentsRoute = read('src/app/api/supervisor/students/route.ts')

describe('فتح بطاقة الطالب من لوحة المتابعة', () => {
  test('البطاقة تحمل userId والمطابقة به أولًا ثم برقم القبول', () => {
    expect(studentsRoute).toContain('userId: app.userId || null')
    expect(board).toContain('onOpenStudent(row.userId, row.admissionId)')
    expect(view).toContain('s.userId === userId')
    expect(view).toContain('s.id === admissionId')
  })

  test('التمرير يذهب لموضع البطاقة نفسها لا لأعلى الصفحة', () => {
    expect(view).toContain('id="supervisor-student-card"')
    expect(view).toContain("getElementById('supervisor-student-card')?.scrollIntoView")
    expect(view).not.toContain('window.scrollTo({ top: 0')
  })
})

describe('مراجعة اختبارات الطالب المسلّمة من بطاقته', () => {
  test('زر مراجعة على الامتحان الفصلي والوحدة المسلّمين ينقل لقسم المراجعة بنفس المحاولة', () => {
    expect(view).toContain("openAttemptReview('PROGRAM', exam.attemptId)")
    expect(view).toContain("openAttemptReview('UNIT', exam.attemptId)")
    expect(view).toContain('focus={reviewFocus}')
  })

  test('تبويب المراجعة يفتح المحاولة المطلوبة عند وصول التركيز', () => {
    expect(gradeTab).toContain('focus?: { type: ')
    expect(gradeTab).toContain('openDetailRef.current(focus.type, focus.id)')
  })
})

describe('الاتصال الصوتي لا يعلّق للأبد', () => {
  test('مهلة قصوى: 45 ثانية بلا رد و30 ثانية لإنشاء الصوت ثم إنهاء واضح', () => {
    expect(voice).toContain("phase === 'calling' ? 45000 : 30000")
    expect(voice).toContain("setPhase('ended')")
    expect(voice).toContain('تعذّر إنشاء الاتصال الصوتي خلال 30 ثانية')
  })

  test('فشل ICE ينهي المكالمة فورًا برسالة عن TURN', () => {
    expect(voice).toContain('oniceconnectionstatechange')
    expect(voice).toContain("pc.iceConnectionState !== 'failed'")
    expect(voice).toContain('فعّل خادم TURN')
  })

  test('تنبيه ظاهر قبل المكالمة عندما TURN غير مفعّل', () => {
    expect(voice).toContain('hasTurn === false')
    expect(voice).toContain('خادم TURN غير مفعّل في إعدادات النظام')
    expect(voice).toContain("startsWith('turn:')")
  })
})
