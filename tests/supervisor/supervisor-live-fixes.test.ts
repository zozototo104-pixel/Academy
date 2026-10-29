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

describe('تحميل كتب برامج طلابه للمشرف', () => {
  const download = read('src/app/api/books/[id]/download/route.ts')
  const contentTab = read('src/components/aact/SupervisorContentTab.tsx')

  test('بوابة التحميل تسمح للمشرف ضمن نطاق برامجه فقط', () => {
    expect(download).toContain('supervisorProgramIds')
    expect(download).toContain("user.role === 'SUPERVISOR'")
    expect(download).toContain('BOOK_OUT_OF_SCOPE')
  })

  test('تبويب المحتوى يعرض رابط فتح/تحميل لكل كتاب', () => {
    expect(contentTab).toContain('/api/books/${b.id}/download')
  })
})

describe('قائمة المراجعة: كل طالب باسمه وكل محاولة باسم امتحانها', () => {
  test('التجميع حسب الطالب واسم الامتحان عنوان المحاولة', () => {
    expect(gradeTab).toContain('attemptsByStudent')
    expect(gradeTab).toContain('group.items.map')
    expect(gradeTab).toContain('{a.exam.title}')
  })
})

describe('فيديوهات محاضرات برامج طلابه ظاهرة للمشرف', () => {
  const videosList = read('src/app/api/admin/lectures/videos/list/route.ts')
  const sessionsList = read('src/app/api/admin/lectures/sessions/list/route.ts')

  test('نطاق قائمة الفيديوهات = برامج طلابه وسلاسله (لا ملكية السلاسل فقط)', () => {
    expect(videosList).toContain('supervisorProgramIds(actor)')
    expect(videosList).not.toContain('db.lectureSeries.findMany')
  })

  test('اللقاءات لا تظهر إلا لمحاضرها الفعلي (قاعدة Haris: لقاءاته هو فقط)', () => {
    expect(sessionsList).toContain('{ lecturerId: actor.id }')
    expect(sessionsList).toContain('{ lecturerId: null, series: { supervisorId: actor.id } }')
  })
})

describe('المحاضر لكل لقاء + تبديل المشرف بعد أول لقاء', () => {
  const sessionPatch = read('src/app/api/admin/lectures/sessions/[id]/route.ts')
  const sessionsList = read('src/app/api/admin/lectures/sessions/list/route.ts')
  const seriesPost = read('src/app/api/admin/lectures/series/route.ts')
  const manage = read('src/lib/lectures/manage.ts')
  const lecturesUi = read('src/components/aact/AdminLectures.tsx')
  const schema = read('prisma/schema.prisma')

  test('النموذج: حقل محاضر خاص على اللقاء يرجع لمشرف السلسلة عند فراغه', () => {
    expect(schema).toContain('lecturerId String?')
    expect(schema).toContain('LectureSessionLecturer')
    expect(manage).toContain('session.lecturerId || series.supervisorId')
    expect(manage).toContain('export function canManageSession')
  })

  test('الرؤية: المشرف يرى لقاءات محاضرها هو فقط (خاص أو عبر السلسلة)', () => {
    expect(sessionsList).toContain('{ lecturerId: actor.id }')
    expect(sessionsList).toContain('{ lecturerId: null, series: { supervisorId: actor.id } }')
    expect(sessionsList).toContain('lecturer: { select: { name: true } }')
  })

  test('تعديل اللقاء يغيّر محاضر هذا اللقاء وحده — إدارة فقط وبنفس تحقق R-04', () => {
    expect(sessionPatch).toContain('supervisorId: z.string().min(1).nullable().optional()')
    expect(sessionPatch).toContain('تغيير المشرف المحاضر من صلاحيات الإدارة')
    expect(sessionPatch).toContain('LECTURE_SESSION_LECTURER_CHANGED')
    expect(sessionPatch).toContain('canManageSession(actor, session, session.series)')
    expect(sessionPatch).not.toContain('db.lectureSeries.update')
    expect(sessionPatch).toContain("target.role !== 'SUPERVISOR' && target.role !== 'ADMIN'")
  })

  test('إنشاء سلسلة متكررة: خيار التبديل يسند اللقاءات من الثاني للبديل', () => {
    expect(seriesPost).toContain('secondSupervisorId: z.string().min(1).optional()')
    expect(seriesPost).toContain('lecturerId: idx === 0 ? null : (input.secondSupervisorId ?? null)')
    expect(lecturesUi).toContain('تبديل المشرف بعد انتهاء اللقاء الأول')
    expect(lecturesUi).toContain('المشرف من اللقاء الثاني فصاعدًا')
  })

  test('نافذة تعديل اللقاء: منتقي محاضر هذا اللقاء مع خيار مشرف السلسلة', () => {
    expect(lecturesUi).toContain('المشرف المحاضر لهذا اللقاء')
    expect(lecturesUi).toContain('مشرف السلسلة ({session.series.supervisor?.name')
    expect(lecturesUi).toContain('ولا يؤثر في باقي لقاءات السلسلة')
    expect(lecturesUi).toContain("showSupervisorSelect={surface === 'admin'}")
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
