import { db } from '@/lib/db'

type StudentLike = {
  id: string
  email: string
  role: string
  emailVerifiedAt?: Date | string | null
}

export function normalizedEmail(value?: string | null) {
  return String(value || '').trim().toLowerCase()
}

export function isVerifiedStudent(user: StudentLike | null | undefined) {
  return !!user && user.role === 'STUDENT' && !!user.emailVerifiedAt && !!normalizedEmail(user.email)
}

export function studentAdmissionOwnershipWhere(user: StudentLike) {
  return {
    userId: user.id,
    email: normalizedEmail(user.email),
  }
}

export function studentPaymentOwnershipWhere(user: StudentLike) {
  const email = normalizedEmail(user.email)
  return {
    OR: [
      { userId: user.id, payerEmail: email },
      { admission: { is: { userId: user.id, email } } },
    ],
  }
}

export function studentDeliverableOwnershipWhere(user: StudentLike) {
  return {
    admission: { is: studentAdmissionOwnershipWhere(user) },
  }
}

export function studentOwnsAdmission(user: StudentLike | null | undefined, app: { userId?: string | null; email?: string | null }) {
  if (!isVerifiedStudent(user)) return false
  return normalizedEmail(app.email) === normalizedEmail(user?.email)
}

export async function repairVerifiedStudentRecordOwnership(user: StudentLike | null | undefined) {
  if (!isVerifiedStudent(user)) return { updatedAdmissions: 0, updatedPayments: 0 }
  const verifiedUser = user as StudentLike

  const email = normalizedEmail(verifiedUser.email)
  const admissions = await db.admissionApplication.findMany({
    where: {
      email,
      OR: [{ userId: null }, { userId: { not: verifiedUser.id } }],
    },
    select: { id: true },
    take: 200,
  }).catch(() => [])
  const admissionIds = admissions.map((a) => a.id)

  const [admissionUpdate, directPaymentUpdate, admissionPaymentUpdate] = await Promise.all([
    admissionIds.length
      ? db.admissionApplication.updateMany({ where: { id: { in: admissionIds } }, data: { userId: verifiedUser.id } }).catch(() => ({ count: 0 }))
      : Promise.resolve({ count: 0 }),
    db.payment.updateMany({
      where: {
        payerEmail: email,
        OR: [{ userId: null }, { userId: { not: verifiedUser.id } }],
      },
      data: { userId: verifiedUser.id },
    }).catch(() => ({ count: 0 })),
    admissionIds.length
      ? db.payment.updateMany({
          where: {
            admissionId: { in: admissionIds },
            OR: [{ userId: null }, { userId: { not: verifiedUser.id } }],
          },
          data: { userId: verifiedUser.id },
        }).catch(() => ({ count: 0 }))
      : Promise.resolve({ count: 0 }),
  ])

  return {
    updatedAdmissions: admissionUpdate.count || 0,
    updatedPayments: (directPaymentUpdate.count || 0) + (admissionPaymentUpdate.count || 0),
  }
}
