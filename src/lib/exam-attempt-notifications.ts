import { notify, notifyAdmins } from '@/lib/notify'
import { assignedSupervisorForStudent, studentHasHumanSupervisor } from '@/lib/supervisor-scope'

// إشعارات نتائج الامتحانات: الطالب يعرف فورًا أن نتيجته تحتاج مراجعة
// المشرف أو أنها اعتُمدت، والإدارة والمشرف البشري يعرفان بالنتيجتين
// (المعتمدة والعالقة) بدل اكتشافهما من القوائم لاحقًا.
// كل الدوال دفاعية بالكامل: فشل أي إشعار لا يكسر تصحيحًا ولا اعتمادًا.

export interface PreliminaryGrade {
  gradedPoints: number
  gradedMaxPoints: number
  pendingCount: number
}

async function notifyAssignedSupervisor(studentId: string, title: string, body: string) {
  try {
    if (!(await studentHasHumanSupervisor(studentId))) return
    const assigned = await assignedSupervisorForStudent(studentId)
    if (assigned?.supervisorId) await notify(assigned.supervisorId, 'GENERAL', title, body)
  } catch {
    // الإشعار لا يعطّل العمل الأصلي أبدًا.
  }
}

export async function notifyAttemptNeedsReview(input: {
  studentId: string
  studentName?: string | null
  examTitle: string
  preliminary?: PreliminaryGrade | null
}) {
  try {
    const studentBody = input.preliminary
      ? `درجتك في «${input.examTitle}» أولية حتى الآن: حصلت على ${input.preliminary.gradedPoints} من ${input.preliminary.gradedMaxPoints} نقطة في الأسئلة المصححة، وهناك ${input.preliminary.pendingCount} سؤال بانتظار تأكيد المشرف. لا يمكنك بدء محاولة جديدة قبل اعتماد النتيجة، وسيصلك إشعار عند اعتمادها.`
      : `إجاباتك في «${input.examTitle}» محفوظة، ونتيجتك بانتظار مراجعة المشرف قبل اعتمادها. لا يمكنك بدء محاولة جديدة قبل الاعتماد، وسيصلك إشعار عند اعتماد النتيجة.`
    await notify(input.studentId, 'GENERAL', 'نتيجتك بانتظار مراجعة المشرف', studentBody, '/?view=dashboard')
    const humansBody = `محاولة ${input.studentName || 'طالب'} في «${input.examTitle}» بانتظار تأكيد التصحيح — الطالب لا يستطيع بدء محاولة جديدة حتى الاعتماد.`
    await notifyAdmins('GENERAL', 'محاولة بانتظار تأكيد التصحيح', humansBody, 'admin')
    await notifyAssignedSupervisor(input.studentId, 'محاولة بانتظار تأكيدك', humansBody)
  } catch {
    // الإشعارات لا تعطّل التصحيح أبدًا.
  }
}

export async function notifyAttemptGraded(input: {
  studentId: string
  studentName?: string | null
  examTitle: string
  score: number
}) {
  try {
    const body = `اعتُمدت نتيجة ${input.studentName || 'طالب'} في «${input.examTitle}»: ${input.score}% — الدرجة معتمدة، ويمكن إعادة تصحيحها من مراجعة التصحيح إن لزم.`
    await notifyAdmins('GENERAL', 'نتيجة امتحان معتمدة', body, 'admin')
    await notifyAssignedSupervisor(input.studentId, 'نتيجة امتحان معتمدة لطالبك', body)
  } catch {
    // الإشعارات لا تعطّل التصحيح أبدًا.
  }
}

export async function notifyStudentReviewResolved(input: {
  studentId: string
  examTitle: string
  score: number
}) {
  try {
    await notify(
      input.studentId,
      'GENERAL',
      'تمت مراجعة نتيجتك واعتمادها',
      `راجعت الإدارة تصحيح «${input.examTitle}» واعتمدت درجتك النهائية: ${input.score}%.`,
      '/?view=dashboard'
    )
  } catch {
    // الإشعارات لا تعطّل الاعتماد أبدًا.
  }
}
