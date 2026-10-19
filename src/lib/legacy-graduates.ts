import { randomBytes } from 'crypto'
import type { NextRequest } from 'next/server'
import { Prisma, type User } from '@prisma/client'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/password'
import { createCertificateQrToken, nextCertificateSerial } from '@/lib/certificate-identity'
import { createPasswordResetToken, passwordResetUrl } from '@/lib/password-reset'
import { emailLegacyGraduateWelcome, type EmailDeliveryStatus } from '@/lib/mailer'
import { notify } from '@/lib/notify'

const LEGACY_GRADUATE_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Tx = Prisma.TransactionClient

type AdminActor = Pick<User, 'id' | 'name'>

export interface LegacyGraduateInput {
  name?: string | null
  email: string
  phone?: string | null
  country?: string | null
  programId: string
  grade?: string | null
  finalScore?: number | null
  issuedAt: Date
  legacySerial?: string | null
}

export class LegacyGraduateError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function cleanString(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function cleanOptional(value: unknown) {
  const text = cleanString(value)
  return text || null
}

export function normalizeLegacyGraduateEmail(email: unknown) {
  return cleanString(email).toLowerCase()
}

export function isValidLegacyGraduateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function randomUnknownPassword() {
  return randomBytes(32).toString('base64url')
}

export async function createLegacyGraduate(input: LegacyGraduateInput, admin: AdminActor) {
  const email = normalizeLegacyGraduateEmail(input.email)
  if (!email || !isValidLegacyGraduateEmail(email)) {
    throw new LegacyGraduateError(400, 'INVALID_EMAIL', 'البريد الإلكتروني غير صالح')
  }

  const programId = cleanString(input.programId)
  if (!programId) throw new LegacyGraduateError(400, 'PROGRAM_REQUIRED', 'البرنامج مطلوب')
  if (!(input.issuedAt instanceof Date) || Number.isNaN(input.issuedAt.getTime())) {
    throw new LegacyGraduateError(400, 'INVALID_ISSUED_AT', 'تاريخ التخرج غير صالح')
  }
  if (input.finalScore != null && (!Number.isFinite(input.finalScore) || input.finalScore < 0 || input.finalScore > 100)) {
    throw new LegacyGraduateError(400, 'INVALID_FINAL_SCORE', 'المعدل يجب أن يكون رقماً بين 0 و 100')
  }

  const result = await db.$transaction(async (tx: Tx) => {
    const program = await tx.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!program) throw new LegacyGraduateError(404, 'PROGRAM_NOT_FOUND', 'البرنامج غير موجود')

    const legacySerial = cleanOptional(input.legacySerial)
    let user = await tx.user.findUnique({ where: { email } })
    if (user && user.role !== 'STUDENT') {
      throw new LegacyGraduateError(409, 'NON_STUDENT_ACCOUNT', 'هذا البريد مرتبط بحساب إداري ولا يمكن تسجيله كخريج')
    }
    const userCreated = !user
    if (!user) {
      const holderName = cleanOptional(input.name)
      if (!holderName) throw new LegacyGraduateError(400, 'NAME_REQUIRED', 'اسم الخريج مطلوب عند إنشاء حساب جديد')
      user = await tx.user.create({
        data: {
          email,
          password: hashPassword(randomUnknownPassword()),
          name: holderName,
          phone: cleanOptional(input.phone),
          country: cleanOptional(input.country),
          role: 'STUDENT',
          status: 'ACTIVE',
        },
      })
    }

    const holderName = cleanOptional(input.name) || user.name
    if (!holderName) throw new LegacyGraduateError(400, 'NAME_REQUIRED', 'اسم صاحب الشهادة مطلوب')

    const enrollment = await tx.enrollment.upsert({
      where: { userId_programId: { userId: user.id, programId: program.id } },
      create: {
        userId: user.id,
        programId: program.id,
        status: 'COMPLETED',
        ...(input.finalScore != null ? { finalScore: input.finalScore } : {}),
      },
      update: {
        status: 'COMPLETED',
        ...(input.finalScore != null ? { finalScore: input.finalScore } : {}),
      },
    })

    const existingCertificate = await tx.certificate.findFirst({
      where: { enrollmentId: enrollment.id, type: 'PROGRAM_COMPLETION' },
    })
    if (existingCertificate && !existingCertificate.legacy) {
      throw new LegacyGraduateError(409, 'CERTIFICATE_ALREADY_EXISTS', 'يوجد شهادة برنامج حالية لهذا التسجيل ولا يمكن تحويلها إلى شهادة خريج سابق')
    }

    if (legacySerial) {
      const duplicate = await tx.certificate.findUnique({ where: { legacySerial } })
      if (duplicate && duplicate.id !== existingCertificate?.id) {
        throw new LegacyGraduateError(409, 'LEGACY_SERIAL_DUPLICATE', 'رقم الشهادة الورقية مستخدم مسبقاً')
      }
    }

    const certificateData = {
      type: 'PROGRAM_COMPLETION',
      legacy: true,
      legacySerial,
      holderName,
      program: cleanOptional(program.titleAr) || cleanOptional(program.titleEn) || program.id,
      grade: cleanOptional(input.grade),
      country: cleanOptional(input.country) || user.country || null,
      issuedAt: input.issuedAt,
      userId: user.id,
      enrollmentId: enrollment.id,
    }

    const certificate = existingCertificate
      ? await tx.certificate.update({
          where: { id: existingCertificate.id },
          data: certificateData,
        })
      : await tx.certificate.create({
          data: {
            ...certificateData,
            serial: await nextCertificateSerial(tx),
            qrToken: createCertificateQrToken(),
          },
        })

    await tx.enrollment.update({
      where: { id: enrollment.id },
      data: {
        status: 'COMPLETED',
        certificateNo: certificate.serial,
        ...(input.finalScore != null ? { finalScore: input.finalScore } : {}),
      },
    })

    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        actorName: admin.name || 'Admin',
        action: existingCertificate ? 'UPDATE_LEGACY_GRADUATE' : 'CREATE_LEGACY_GRADUATE',
        entity: 'Certificate',
        entityId: certificate.id,
        details: `${certificate.serial} — ${holderName} — ${email}${legacySerial ? ` — legacySerial=${legacySerial}` : ''}`,
      },
    })

    return { user, userCreated, enrollment, certificate }
  })
}

export async function sendLegacyGraduatePasswordSetup(req: NextRequest, userId: string): Promise<EmailDeliveryStatus> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } })
    if (!user) return 'FAILED'
    const reset = createPasswordResetToken()
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: reset.tokenHash,
        passwordResetExpiresAt: reset.expiresAt,
        passwordResetUsedAt: null,
      },
    })
    const url = passwordResetUrl(req, reset.token)
    return await emailPasswordResetDetailed(user.email, user.name, url)
  } catch (error) {
    console.warn('legacy graduate password setup email failed:', error)
    return 'FAILED'
  }
}
