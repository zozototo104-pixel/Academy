// Comprehensive exam — phase 2 (candidates, invitations, attempts,
// auto-grading, qualification, dual-channel invite sending).
// Closed questions ONLY (MCQ | TF), same as phase 1. No essay type
// anywhere in this module.
// Pure helpers are directly unit-testable; the DB-backed helpers take
// an explicit transaction client so tests can pass a fake.
import { randomBytes, timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { gradeObjectiveAnswer } from '@/lib/answer-completeness'
import { normalizeDigits, normalizePhone, normalizePhoneToInternationalWaId, validatePhone } from '@/lib/admission-validation'
import { validateAdmissionFileSignature } from '@/lib/file-signature'
import { emailTemplate, sendEmailDetailed } from '@/lib/mailer'
import { createCertificateQrToken, nextCertificateSerial } from '@/lib/certificate-identity'
import { sendOfficialWhatsAppTemplate } from '@/lib/whatsapp-cloud'
import { recordWhatsAppOutboundMessage } from '@/lib/whatsapp-conversations'
import { storeFileBuffer } from '@/lib/storage'
import { createPasswordResetToken, passwordResetUrl } from '@/lib/password-reset'

export const COMPREHENSIVE_EXAM_INVITE_VALIDITY_DAYS = 7
export const COMPREHENSIVE_EXAM_INVITE_TOKEN_BYTES = 32
export const COMPREHENSIVE_EXAM_CANDIDATE_FILE_MAX_BYTES = 10 * 1024 * 1024 // 10MB per file
export const COMPREHENSIVE_EXAM_CANDIDATE_FILE_NAMESPACE = 'comprehensive-exam-candidates'
export const COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE_KEY = 'COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'
export const COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE_KEY = 'COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE'
export const COMPREHENSIVE_EXAM_WHATSAPP_WABA_ID_KEY = 'COMPREHENSIVE_EXAM_WHATSAPP_WABA_ID'
export const COMPREHENSIVE_EXAM_CANDIDATE_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const
export const COMPREHENSIVE_EXAM_INVITATION_STATUSES = ['PENDING', 'USED', 'EXPIRED', 'REVOKED'] as const

export class ComprehensiveExamPhase2Error extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// A concurrent same-specialization qualification can reach the DB unique
// index before the in-transaction duplicate check observes the other row.
// Report this specific conflict as an actionable 409, never a generic 500.
export function isComprehensiveCertificateScopeConflict(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } } | null
  const target = e?.meta?.target
  return e?.code === 'P2002' && Array.isArray(target) &&
    ['enrollmentId', 'type', 'certificateScope'].every((field) => target.includes(field))
}

export function normalizeComprehensiveNationalId(value: unknown): string {
  return normalizeDigits(String(value || '').trim())
    .replace(/[\s-]/g, '')
    .toUpperCase()
}

export type ValidatedComprehensiveCandidateInput =
  | {
      ok: true
      data: { fullName: string; nationalId: string; email: string; phone: string }
    }
  | { ok: false; errors: string[] }

function cleanCandidateText(value: unknown, max = 120): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// The single validation gate for every candidate entering the flow,
// whether the candidate applied themselves or the admin filed them.
export function validateComprehensiveCandidateInput(raw: {
  fullName?: unknown
  nationalId?: unknown
  email?: unknown
  phone?: unknown
}): ValidatedComprehensiveCandidateInput {
  const errors: string[] = []
  const fullName = cleanCandidateText(raw?.fullName, 120)
  if (fullName.length < 3) errors.push('الاسم الكامل مطلوب (3 أحرف على الأقل)')
  const nationalId = normalizeComprehensiveNationalId(raw?.nationalId)
  if (!/^[A-Za-z0-9]{6,30}$/.test(nationalId)) {
    errors.push('رقم الهوية غير صالح — 6 إلى 30 حرفاً أو رقماً، بلا فراغات')
  }
  const email = cleanCandidateText(raw?.email, 180).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('البريد الإلكتروني غير صالح')
  const phoneError = validatePhone(String(raw?.phone ?? ''))
  if (phoneError) errors.push(phoneError)
  if (errors.length) return { ok: false, errors }
  return { ok: true, data: { fullName, nationalId, email, phone: normalizePhone(String(raw?.phone ?? '')) } }
}

// Candidate documents are identity papers: image or PDF only, magic
// bytes verified (never trust the extension or the claimed MIME).
export function validateComprehensiveCandidateFile(file: {
  name: string
  size: number
  type?: string | null
  buffer: Buffer
}): { ok: true; mimeType: string } | { ok: false; error: string } {
  if (!Buffer.isBuffer(file.buffer) || file.buffer.byteLength === 0) {
    return { ok: false, error: `ملف «${file.name}» فارغ أو غير صالح` }
  }
  if (file.size > COMPREHENSIVE_EXAM_CANDIDATE_FILE_MAX_BYTES) {
    return { ok: false, error: `حجم ملف «${file.name}» يتجاوز الحد الأقصى 10 ميغابايت` }
  }
  const checked = validateAdmissionFileSignature({ buffer: file.buffer, fileName: file.name, mimeType: file.type })
  if (!checked.ok) return { ok: false, error: `تم رفض ملف «${file.name}»: ${checked.error}` }
  if (!['jpeg', 'png', 'webp', 'heic', 'pdf'].includes(checked.kind)) {
    return { ok: false, error: `ملف «${file.name}» يجب أن يكون صورة أو PDF — وثائق الهوية والشهادات فقط` }
  }
  return { ok: true, mimeType: checked.mimeType }
}

// ---- Dedupe ----

export type ComprehensiveCandidateDuplicate =
  | { code: 'NATIONAL_ID_DUPLICATE'; message: string }
  | { code: 'EMAIL_ALREADY_GRADUATE'; message: string }
  | null

// One person, one program, one graduate record — scoped per SPECIALIZATION
// (phase 3). Checked at application time, at invitation time, and again
// inside the qualification transaction. REJECTED candidates never block
// a re-application; the candidate being checked never blocks itself.
// A graduate of one specialization may always apply for another.
// The two graduate branches split because the two record kinds live in
// different programs: a legacy record's enrollment IS a study program
// (i.e. the specialization itself), while a comprehensive-exam record's
// enrollment is in the equivalency program and its specialization lives
// on its exam. Comparing the legacy branch against the equivalency
// program would never match (legacy enrollments never sit there) and
// would let a legacy graduate of specialization X re-qualify in X.
export async function checkComprehensiveCandidateDuplicate(
  tx: Prisma.TransactionClient,
  input: { examId: string; programId: string; specializationProgramId?: string | null; nationalId: string; email: string; excludeCandidateId?: string | null },
): Promise<ComprehensiveCandidateDuplicate> {
  const otherCandidate = await tx.comprehensiveExamCandidate.findFirst({
    where: {
      examId: input.examId,
      nationalId: input.nationalId,
      status: { not: 'REJECTED' },
      ...(input.excludeCandidateId ? { id: { not: input.excludeCandidateId } } : {}),
    },
    select: { id: true },
  })
  if (otherCandidate) {
    return {
      code: 'NATIONAL_ID_DUPLICATE',
      message: 'يوجد طلب بهذا الرقم الوطني لنفس البرنامج — لا يمكن إنشاء طلب ثانٍ',
    }
  }
  // The specialization in question: the exam's specialization, or — for
  // pre-phase-3 exams, whose program WAS the specialization — the program.
  const specializationId = input.specializationProgramId || input.programId
  const legacyGraduate = await tx.certificate.findFirst({
    where: {
      enrollment: { programId: specializationId },
      user: { email: input.email },
      legacy: true,
    },
    select: { id: true },
  })
  if (legacyGraduate) {
    return { code: 'EMAIL_ALREADY_GRADUATE', message: 'موجود أصلاً كخريج' }
  }
  if (input.specializationProgramId) {
    const examGraduate = await tx.certificate.findFirst({
      where: {
        enrollment: { programId: input.programId },
        user: { email: input.email },
        type: 'COMPREHENSIVE_EXAM',
        certificateScope: input.specializationProgramId,
      },
      select: { id: true },
    })
    if (examGraduate) {
      return { code: 'EMAIL_ALREADY_GRADUATE', message: 'موجود أصلاً كخريج' }
    }
  }
  return null
}

export function checkComprehensiveDuplicateError(
  duplicate: ComprehensiveCandidateDuplicate,
): ComprehensiveExamPhase2Error | null {
  if (!duplicate) return null
  return new ComprehensiveExamPhase2Error(409, duplicate.code, duplicate.message)
}

// ---- Invite gates (corrected design §6) ----

export type ComprehensiveInviteGate =
  | { code: 'EXAM_NOT_READY'; message: string }
  | { code: 'PAYMENT_REQUIRED'; message: string }
  | null

// Exam must be published, and payment must be officially recorded.
// Application candidates use their SERVICE_FEE invoice; direct admin
// candidates use a separate one-to-one Payment linked to the candidate.
// Used consistently by issuing, renewing and displaying invitations.
export async function checkComprehensiveInviteGates(
  tx: Prisma.TransactionClient,
  input: { candidate: { id?: string; submittedBy?: string; admissionApplicationId?: string | null }; exam: { status: string } },
): Promise<ComprehensiveInviteGate> {
  if (input.exam.status !== 'READY') {
    return { code: 'EXAM_NOT_READY', message: 'الامتحان غير منشور بعد — جهّزه وانشره أولاً' }
  }
  if (input.candidate.admissionApplicationId) {
    const paid = await tx.payment.findFirst({
      where: { admissionId: input.candidate.admissionApplicationId, purpose: 'SERVICE_FEE', status: { in: ['PAID', 'WAIVED'] } },
      select: { id: true },
    })
    if (!paid) {
      return { code: 'PAYMENT_REQUIRED', message: 'رسوم الخدمة لم تُسدد بعد — لا يُرسَل الرابط قبل السداد' }
    }
  } else if (input.candidate.submittedBy === 'ADMIN') {
    const paid = input.candidate.id ? await tx.payment.findFirst({
      where: { comprehensiveExamCandidateId: input.candidate.id, purpose: 'SERVICE_FEE', status: 'PAID' },
      select: { id: true },
    }) : null
    if (!paid) {
      return { code: 'PAYMENT_REQUIRED', message: 'سجّل المبلغ المستلم من زر «تم الدفع» قبل إصدار رابط الامتحان' }
    }
  }
  return null
}

export function checkComprehensiveInviteGateError(gate: ComprehensiveInviteGate): ComprehensiveExamPhase2Error | null {
  if (!gate) return null
  return new ComprehensiveExamPhase2Error(409, gate.code, gate.message)
}

// ---- Invitations ----

export function createComprehensiveExamInviteToken(): string {
  return randomBytes(COMPREHENSIVE_EXAM_INVITE_TOKEN_BYTES).toString('hex')
}

export function comprehensiveExamInviteExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + COMPREHENSIVE_EXAM_INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
}

export function isComprehensiveExamInvitationExpired(invitation: { expiresAt: Date | string }): boolean {
  return new Date(invitation.expiresAt).getTime() <= Date.now()
}

// Constant-time token comparison: length mismatch fails closed
// without leaking the expected length through timing.
export function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(String(presented || ''), 'utf8')
  const b = Buffer.from(String(expected || ''), 'utf8')
  // An empty token never matches: a missing token must not validate.
  if (a.length === 0 || b.length === 0) return false
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---- Seeded shuffle (per-attempt display order) ----

// The display order is derived from the attempt id alone, so a
// reload shows exactly the same questions in the same order with the
// same option order — no extra columns, no stored shuffle to drift.
// FNV-1a hash -> mulberry32 -> Fisher-Yates.
function seedFromString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(seed: string, items: T[]): T[] {
  const arr = [...items]
  const rand = mulberry32(seedFromString(seed))
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export type ComprehensiveAttemptSnapshotQuestion = {
  questionId: string
  order: number
  type: string
  text: string
  options: string[]
  correctAnswer: string
}

export type ComprehensiveAttemptDisplayQuestion = {
  questionId: string
  order: number
  type: string
  text: string
  displayOptions: string[]
  // displayToReal[displayIndex] = real option index — the only map
  // between what the candidate saw and what gets graded.
  displayToReal: number[]
}

export function parseComprehensiveAttemptSnapshot(raw: string | null | undefined): ComprehensiveAttemptSnapshotQuestion[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    // Old attempts store a plain array. New attempts also freeze the
    // published time limit and pass mark beside the question snapshot.
    const questions = Array.isArray(parsed) ? parsed : parsed?.questions
    if (!Array.isArray(questions)) return []
    return questions
      .filter((q) => q && typeof q.questionId === 'string' && Array.isArray(q.options) && typeof q.correctAnswer === 'string')
      .map((q) => ({
        questionId: q.questionId,
        order: typeof q.order === 'number' ? q.order : 0,
        type: String(q.type || 'MCQ'),
        text: String(q.text || ''),
        options: q.options.map((o: unknown) => String(o)),
        correctAnswer: String(q.correctAnswer),
      }))
  } catch {
    return []
  }
}

// The exam's settings may change after a candidate starts (for example
// when an administrator unpublishes a later exam). Existing legacy array
// snapshots use the current values; new snapshots freeze both settings.
export function parseComprehensiveAttemptTerms(
  raw: string | null | undefined,
  fallback: { passScore: number; durationMin: number },
): { passScore: number; durationMin: number } {
  try {
    const saved = JSON.parse(raw || '')
    if (!saved || Array.isArray(saved) || !Array.isArray(saved.questions)) return fallback
    const passScore = saved.passScore
    const durationMin = saved.durationMin
    return {
      passScore: Number.isSafeInteger(passScore) && passScore >= 1 && passScore <= 100 ? passScore : fallback.passScore,
      durationMin: Number.isSafeInteger(durationMin) && durationMin >= 10 && durationMin <= 480 ? durationMin : fallback.durationMin,
    }
  } catch {
    return fallback
  }
}

export function buildComprehensiveAttemptSnapshot(
  questions: Array<{ id: string; order: number; type: string; text: string; options: string | null; correctAnswer: string | null }>,
): ComprehensiveAttemptSnapshotQuestion[] {
  return questions
    .filter((q) => q.correctAnswer !== null && q.correctAnswer !== undefined)
    .map((q) => {
      let options: string[] = []
      try {
        const parsed = q.options ? JSON.parse(q.options) : []
        options = Array.isArray(parsed) ? parsed.map((o) => String(o)) : []
      } catch {
        options = []
      }
      return { questionId: q.id, order: q.order, type: q.type, text: q.text, options, correctAnswer: String(q.correctAnswer) }
    })
}

// Shuffles the question order AND the option order inside every
// question, deterministically for one attempt id.
export function buildComprehensiveAttemptDisplay(
  attemptId: string,
  snapshot: ComprehensiveAttemptSnapshotQuestion[],
): ComprehensiveAttemptDisplayQuestion[] {
  const shuffledQuestions = seededShuffle(`q:${attemptId}`, snapshot)
  return shuffledQuestions.map((q) => {
    const realIndexes = q.options.map((_, i) => i)
    const displayOrder = seededShuffle(`o:${attemptId}:${q.questionId}`, realIndexes)
    return {
      questionId: q.questionId,
      order: q.order,
      type: q.type,
      text: q.text,
      displayOptions: displayOrder.map((realIdx) => q.options[realIdx]),
      displayToReal: displayOrder,
    }
  })
}

// ---- Grading ----

export type ComprehensiveAttemptAnswerInput = { questionId: string; selectedOption: number | null }

export type ComprehensiveAttemptGrade = {
  earnedPoints: number
  totalPoints: number
  score: number
  passed: boolean
  perQuestion: Array<{ questionId: string; selectedOption: number | null; isCorrect: boolean; points: number }>
}

// Grades against the attempt snapshot through the same display map
// the candidate saw. An incomplete answer key is a hard failure —
// the admin must fix the key, never grade by guesswork.
export function gradeComprehensiveAttempt(input: {
  attemptId: string
  snapshot: ComprehensiveAttemptSnapshotQuestion[]
  display: ComprehensiveAttemptDisplayQuestion[]
  answers: ComprehensiveAttemptAnswerInput[]
  passScore: number
}): ComprehensiveAttemptGrade {
  const displayById = new Map(input.display.map((q) => [q.questionId, q]))
  const answerById = new Map(input.answers.map((a) => [a.questionId, a]))
  const perQuestion: ComprehensiveAttemptGrade['perQuestion'] = []
  let earnedPoints = 0
  const totalPoints = input.snapshot.length * 2
  for (const question of input.snapshot) {
    const display = displayById.get(question.questionId)
    const answer = answerById.get(question.questionId)
    const displayIndex =
      answer && typeof answer.selectedOption === 'number' && Number.isInteger(answer.selectedOption) ? answer.selectedOption : null
    const realIndex = displayIndex !== null && display && display.displayToReal[displayIndex] !== undefined ? display.displayToReal[displayIndex] : null
    const graded = gradeObjectiveAnswer({
      optionsRaw: JSON.stringify(question.options),
      correctAnswerRaw: question.correctAnswer,
      selectedOption: realIndex,
      maxPoints: 2,
    })
    if (!graded) {
      throw new ComprehensiveExamPhase2Error(500, 'INCOMPLETE_ANSWER_KEY', 'مفتاح الإجابة غير مكتمل لسؤال في الامتحان — أبلغ الإدارة لتصحيحه قبل التصحيح')
    }
    earnedPoints += graded.points
    perQuestion.push({ questionId: question.questionId, selectedOption: realIndex, isCorrect: graded.isCorrect, points: graded.points })
  }
  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 100 : 0
  return { earnedPoints, totalPoints, score, passed: score >= input.passScore, perQuestion }
}

// ---- Invite sending (email + WhatsApp, both, visibly) ----

export function buildComprehensiveExamInviteUrl(token: string): string {
  const appUrl = String(process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.com').replace(/\/$/, '')
  return `${appUrl}/comprehensive-exam/${encodeURIComponent(token)}`
}

function formatInviteExpiryDate(expiresAt: Date): string {
  return expiresAt.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Invitation template name, locale and optional WABA ID live in admin
// settings with env fallbacks. They must match the approved Meta template;
// the old locale stays "ar" when no explicit language was configured.
export async function readComprehensiveExamWhatsAppTemplate(): Promise<string | null> {
  const row = await (db as any).setting?.findUnique?.({ where: { key: COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE_KEY } })
  const stored = String(row?.value || '').trim()
  if (stored) return stored
  return process.env.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE?.trim() || null
}

export async function readComprehensiveExamWhatsAppLanguage(): Promise<string> {
  const row = await (db as any).setting?.findUnique?.({ where: { key: COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE_KEY } })
  return String(row?.value || process.env.COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE || '').trim() || 'ar'
}

export async function readComprehensiveExamWhatsAppWabaId(): Promise<string> {
  const row = await (db as any).setting?.findUnique?.({ where: { key: COMPREHENSIVE_EXAM_WHATSAPP_WABA_ID_KEY } })
  return String(row?.value || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim()
}

export type ComprehensiveInviteChannelStatus = 'SENT' | 'SKIPPED' | 'FAILED' | 'NOT_CONFIGURED'

export type ComprehensiveInviteDelivery = {
  email: { status: ComprehensiveInviteChannelStatus; error?: string }
  whatsapp: { status: ComprehensiveInviteChannelStatus; error?: string }
}

export type ComprehensiveInviteSendInput = {
  fullName: string
  email: string
  phone: string
  examTitle: string
  programTitle: string
  durationMin: number
  inviteUrl: string
  expiresAt: Date
  // Country as registered on the candidate's application (Arabic name,
  // e.g. 'فلسطين' / 'السعودية'). Used ONLY to normalise the archived
  // WhatsApp conversation id; the send itself is untouched.
  country?: string | null
}

export { normalizePhoneToInternationalWaId } from '@/lib/admission-validation'

// Country for the invite archive: the application first (its country field
// is required), then the linked student account. Any lookup failure yields
// null — the archive then keeps the number as stored instead of guessing.
export async function resolveComprehensiveInviteCountry(candidate: {
  admissionApplicationId?: string | null
  userId?: string | null
}): Promise<string | null> {
  try {
    if (candidate.admissionApplicationId) {
      const application = await db.admissionApplication?.findUnique?.({
        where: { id: candidate.admissionApplicationId },
        select: { country: true },
      })
      const country = String((application as any)?.country || '').trim()
      if (country) return country
    }
    if (candidate.userId) {
      const user = await db.user?.findUnique?.({
        where: { id: candidate.userId },
        select: { country: true },
      })
      const country = String((user as any)?.country || '').trim()
      if (country) return country
    }
  } catch {
    return null
  }
  return null
}

// Sends on BOTH channels. A failure on one channel never blocks the
// other, and no failure is ever hidden: every outcome (SENT, SKIPPED,
// FAILED, NOT_CONFIGURED) comes back with its reason, so the admin
// always sees what actually reached the candidate — the silent
// "$0-balance looks sent" failure must not repeat.
export async function sendComprehensiveExamInvite(input: ComprehensiveInviteSendInput): Promise<ComprehensiveInviteDelivery> {
  const delivery: ComprehensiveInviteDelivery = {
    email: { status: 'FAILED', error: 'لم تُرسَل' },
    whatsapp: { status: 'FAILED', error: 'لم تُرسَل' },
  }

  // Email first (Resend/SMTP via the platform's mailer, with logging).
  try {
    const html = emailTemplate(
      'دعوتك للامتحان الشامل',
      `<p>مرحباً ${input.fullName}،</p><p>تمت الموافقة على طلبك لمعادلة مؤهلك السابق، وندعوك لأداء الامتحان الشامل لبرنامج «${input.programTitle}».</p><p>الرابط صالح حتى ${formatInviteExpiryDate(input.expiresAt)}، ومحاولة واحدة فقط، ومدة الامتحان ${input.durationMin} دقيقة.</p><p>افتح الرابط وابدأ الامتحان في الوقت المناسب لك — لا تشارك الرابط مع أحد، فهو شخصي.</p>`,
      { label: 'فتح رابط الامتحان', url: input.inviteUrl },
    )
    const status = await sendEmailDetailed({
      to: input.email,
      subject: `دعوتك للامتحان الشامل — ${input.programTitle}`,
      html,
      event: 'COMPREHENSIVE_EXAM_INVITE',
    })
    if (status === 'SENT') delivery.email = { status: 'SENT' }
    else if (status === 'SKIPPED') delivery.email = { status: 'SKIPPED', error: 'البريد غير مهيأ — أضف SMTP من لوحة الإدارة أو RESEND_API_KEY و MAIL_FROM' }
    else delivery.email = { status: 'FAILED', error: 'تعذر إرسال البريد — راجع سجل البريد في لوحة الإدارة' }
  } catch (e: any) {
    delivery.email = { status: 'FAILED', error: String(e?.message || e).slice(0, 300) }
  }

  // WhatsApp second (Meta template via the existing cloud path).
  try {
    const templateName = await readComprehensiveExamWhatsAppTemplate()
    if (!templateName) {
      delivery.whatsapp = {
        status: 'NOT_CONFIGURED',
        error: 'لم يُحفظ اسم قالب واتساب بعد — احفظه في لوحة الإدارة ← النظام ← قالب واتساب لدعوة الامتحان الشامل',
      }
    } else {
      const languageCode = await readComprehensiveExamWhatsAppLanguage()
      const wabaId = await readComprehensiveExamWhatsAppWabaId()
      const phone = normalizePhone(input.phone)
      const digits = phone.replace(/\D/g, '')
      if (digits.length < 8 || digits.length > 15) {
        delivery.whatsapp = { status: 'FAILED', error: 'رقم الهاتف غير صالح لواتساب' }
      } else {
        // Body placeholders, in order: {{1}} name, {{2}} exam/program,
        // {{3}} expiry date, {{4}} invite link (tappable in WhatsApp).
        // Unknown legacy templates without WABA preflight stay body-only.
        // For a known image template (or a verifiable custom template), offer
        // the public logo; the sender only attaches it when Meta requires IMAGE.
        const headerImageUrl = templateName === 'comprehensive_exam_invite_ar' || wabaId
          ? 'https://www.aactacademy.com/logo.png' : undefined
        const expiryText = formatInviteExpiryDate(input.expiresAt)
        const parameters = [input.fullName, input.examTitle, expiryText, input.inviteUrl]
        const result = await sendOfficialWhatsAppTemplate(phone, templateName, parameters, { languageCode, wabaId, headerImageUrl })
        const whatsappMessageId = String(result?.messages?.[0]?.id || '').trim()
        delivery.whatsapp = {
          status: 'SENT',
          ...(whatsappMessageId ? {} : { error: 'قبلت Meta طلب الإرسال، لكن لم تُرجع معرّف الرسالة لتتبّع التسليم' }),
        }
        try {
          // This is a summary of the approved template's variables, not a
          // reconstruction of Meta's template wording.
          await recordWhatsAppOutboundMessage({
            waId: normalizePhoneToInternationalWaId(phone, input.country),
            displayName: input.fullName,
            text: `قالب دعوة الامتحان الشامل «${templateName}»\nالمرشح: ${input.fullName}\nالامتحان: ${input.examTitle}\nصالح حتى: ${expiryText}\nرابط الامتحان: ${input.inviteUrl}`,
            sender: 'SYSTEM',
            sentByName: 'خدمة الامتحان الشامل',
            whatsappMessageId: whatsappMessageId || null,
            rawType: 'template',
            meta: { templateName, languageCode, headerImageUrl: headerImageUrl || null },
            requireSavedMessage: true,
          })
        } catch (archiveError) {
          // Meta has already accepted the message. Never misreport a
          // conversation-archive failure as a failed WhatsApp send.
          console.error('comprehensive exam WhatsApp conversation archive failed:', archiveError)
          delivery.whatsapp.error = 'قبلت Meta طلب الإرسال، لكن تعذّر حفظ الرسالة في محادثات المنصة'
        }
      }
    }
  } catch (e: any) {
    delivery.whatsapp = { status: 'FAILED', error: String(e?.message || e).slice(0, 300) }
  }

  return delivery
}

// Account setup for admin-entered candidates, identical to the legacy
// graduate's one-time 7-day password setup, but with correct exam wording.
// Passwords never leave the server. A failed email is visible and can
// be resent by the admin without creating a second account.
export async function sendComprehensiveCandidatePasswordSetup(req: NextRequest, userId: string) {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } })
    if (!user) return 'FAILED' as const
    const reset = createPasswordResetToken(7 * 24 * 60 * 60 * 1000)
    await db.user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash: reset.tokenHash, passwordResetExpiresAt: reset.expiresAt, passwordResetUsedAt: null },
    })
    const url = passwordResetUrl(req, reset.token)
    return await sendEmailDetailed({
      to: user.email,
      identityMail: true,
      event: 'COMPREHENSIVE_EXAM_ACCOUNT_SETUP',
      subject: 'حسابك في منصة الأكاديمية — استكمال معادلة الشهادة',
      html: emailTemplate(
        'تم إنشاء حسابك لرحلة معادلة الشهادة',
        '<p>أدخلت إدارة الأكاديمية بياناتك كمرشح لامتحان معادلة الشهادة. تم إنشاء حساب طالب باسمك، ولأمانك لم تُرسل أي كلمة مرور عبر البريد.</p><p>اضغط لاختيار كلمة المرور والدخول إلى حسابك. الرابط صالح لمدة 7 أيام ويُستخدم مرة واحدة فقط. دعوة الامتحان تُرسل لاحقاً بعد اعتماد الملف وتوثيق الدفعة.</p>',
        { label: 'اختيار كلمة المرور', url },
      ),
    })
  } catch (error) {
    console.warn('comprehensive candidate account setup failed:', error)
    return 'FAILED' as const
  }
}

// ---- Qualification (only on pass, in ONE transaction) ----

export type ComprehensiveQualificationResult = {
  user: { id: string; email: string; name: string }
  userCreated: boolean
  enrollment: { id: string }
  certificate: { id: string; serial: string; qrToken: string }
}

function normalizeQualificationEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase()
}

// Mirrors createLegacyGraduate's enrollment pattern, but the USER is
// never created here — the candidate links to the existing registered
// user (userId first, email as fallback); a missing user fails visibly.
// The certificate is a SEPARATE type (COMPREHENSIVE_EXAM, legacy: false)
// so it never lands in the previous-graduates lists. The enrollment
// stays in the EQUIVALENCY program (input.program); the certificate
// itself is issued IN THE SPECIALIZATION (input.specialization) —
// certificate.program is the specialization program's name, so the
// certificate IS in that specialization, issued via equivalency.
// Must be called inside db.$transaction — the dedupe re-check, the
// user, the enrollment and the certificate all commit or none do.
export async function qualifyComprehensiveExamCandidate(
  tx: Prisma.TransactionClient,
  input: {
    candidate: { id: string; userId?: string | null; fullName: string; nationalId: string; email: string; phone: string | null }
    exam: { id: string; programId: string }
    program: { id: string; titleAr: string | null; titleEn: string | null }
    specialization: { id: string; titleAr: string | null; titleEn: string | null }
    attempt: { id: string; score: number }
    admin: { id: string | null; name: string | null }
  },
): Promise<ComprehensiveQualificationResult> {
  const email = normalizeQualificationEmail(input.candidate.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ComprehensiveExamPhase2Error(400, 'INVALID_EMAIL', 'البريد الإلكتروني غير صالح')
  }
  if (!input.specialization?.id) {
    throw new ComprehensiveExamPhase2Error(400, 'SPECIALIZATION_REQUIRED', 'الامتحان بلا تخصص — حدّد تخصص الامتحان قبل التأهيل')
  }

  // Dedupe re-check INSIDE the transaction: another candidate with the
  // same national ID, or an already-issued graduate certificate for
  // this email + specialization — either way, no second record.
  const duplicate = await checkComprehensiveCandidateDuplicate(tx, {
    examId: input.exam.id,
    programId: input.exam.programId,
    specializationProgramId: input.specialization.id,
    nationalId: input.candidate.nationalId,
    email,
    excludeCandidateId: input.candidate.id,
  })
  const duplicateError = checkComprehensiveDuplicateError(duplicate)
  if (duplicateError) throw duplicateError

  // The candidate links to an EXISTING registered user — the platform
  // accepts no application without login, so the user already exists.
  // NEVER create an account here: a missing user is a visible error
  // for the admin to fix (a wrong link), not a reason to invent one.
  // The linked user wins; the email is only a fallback for candidates
  // created before the link existed.
  let user = input.candidate.userId ? await tx.user.findUnique({ where: { id: input.candidate.userId } }) : null
  if (!user) {
    user = await tx.user.findUnique({ where: { email } })
  }
  if (!user) {
    throw new ComprehensiveExamPhase2Error(409, 'USER_NOT_FOUND', 'لا يوجد حساب مسجل لهذا المرشح — سجّل الطالب أولاً ثم أعد التأهيل')
  }
  if (user.role !== 'STUDENT') {
    throw new ComprehensiveExamPhase2Error(409, 'NON_STUDENT_ACCOUNT', 'هذا البريد مرتبط بحساب إداري ولا يمكن تسجيله كخريج')
  }
  const userCreated = false
  if (!user.phone && input.candidate.phone) {
    user = await tx.user.update({ where: { id: user.id }, data: { phone: input.candidate.phone } })
  }

  const holderName = String(input.candidate.fullName || '').trim() || user.name
  const score = input.attempt.score
  const enrollment = await tx.enrollment.upsert({
    where: { userId_programId: { userId: user.id, programId: input.program.id } },
    create: { userId: user.id, programId: input.program.id, status: 'COMPLETED', finalScore: score },
    update: { status: 'COMPLETED', finalScore: score },
  })

  const existingCertificate = await tx.certificate.findFirst({
    // Multiple specializations share the equivalency enrollment; only
    // the SAME specialization is a duplicate certificate.
    where: {
      enrollmentId: enrollment.id,
      type: 'COMPREHENSIVE_EXAM',
      comprehensiveExam: { specializationProgramId: input.specialization.id },
    },
  })
  if (existingCertificate) {
    throw new ComprehensiveExamPhase2Error(409, 'CERTIFICATE_ALREADY_EXISTS', 'موجود أصلاً كخريج')
  }

  const programTitle = String(input.specialization.titleAr || input.specialization.titleEn || input.specialization.id)
  const certificate = await tx.certificate.create({
    data: {
      type: 'COMPREHENSIVE_EXAM',
      legacy: false,
      holderName,
      program: programTitle,
      programEn: input.specialization.titleEn || null,
      grade: `${score}%`,
      country: user.country || null,
      issuedAt: new Date(),
      userId: user.id,
      enrollmentId: enrollment.id,
      comprehensiveExamId: input.exam.id,
      serial: await nextCertificateSerial(tx),
      qrToken: createCertificateQrToken(),
    },
  })

  await tx.enrollment.update({
    where: { id: enrollment.id },
    data: { status: 'COMPLETED', certificateNo: certificate.serial, finalScore: score },
  })

  await tx.auditLog.create({
    data: {
      actorId: input.admin.id || null,
      actorName: input.admin.name || 'النظام',
      action: 'QUALIFY_COMPREHENSIVE_EXAM',
      entity: 'Certificate',
      entityId: certificate.id,
      details: `${certificate.serial} — ${holderName} — ${email} — امتحان شامل ${score}% — التخصص: ${programTitle}`,
    },
  })

  return {
    user: { id: user.id, email: user.email, name: user.name },
    userCreated,
    enrollment: { id: enrollment.id },
    certificate: { id: certificate.id, serial: certificate.serial, qrToken: certificate.qrToken },
  }
}

// ---- Candidate from an approved equivalency application ----

export type ComprehensiveApplicationFileInput = {
  docType: string
  fileName: string
  mimeType: string
  size: number
  storageKey: string | null
}

export type ComprehensiveCandidateFromApplicationResult = {
  created: boolean
  candidateId: string | null
  examId: string | null
}

// Creates the exam candidate when the admin approves an equivalency
// service application (RESULT_APPROVED branch of the admin admissions
// PATCH). The candidate is created as APPROVED — the admin's approval
// IS the file review, no second identical review in the panel.
// Idempotent: the same application never creates a second candidate
// (looked up by admissionApplicationId, not by exam+nationalId, so a
// re-approval after the exam was archived still finds its candidate).
// The exam is resolved as the live (READY first, else DRAFT) exam for
// (equivalency program, specialization); when no live exam exists the
// approval is BLOCKED with EXAM_NOT_PREPARED — creating the draft takes
// seconds, and the block guarantees every approved equivalency
// application has a candidate. Applications without a specialization
// (submitted before the picker existed) are skipped, not blocked —
// the admin files those candidates manually from the panel.
// Documents come from the application's files: the service flow's
// required documents are ordered, so FLOW_DOC_1 is the training
// certificate and FLOW_DOC_4 is the ID/passport; the fallbacks cover
// applications whose files were attached under other types.
export async function createComprehensiveCandidateFromApplication(
  tx: Prisma.TransactionClient,
  input: {
    application: {
      id: string
      fullName: string
      nationalId: string | null
      email: string
      phone: string | null
      userId: string | null
      programId: string | null
      specializationProgramId: string | null
    }
    files: ComprehensiveApplicationFileInput[]
    admin: { id: string | null; name: string | null }
  },
): Promise<ComprehensiveCandidateFromApplicationResult> {
  const app = input.application
  if (!app.specializationProgramId || !app.programId) {
    return { created: false, candidateId: null, examId: null }
  }
  const existing = await tx.comprehensiveExamCandidate.findFirst({
    where: { admissionApplicationId: app.id },
    select: { id: true, examId: true },
  })
  if (existing) {
    return { created: false, candidateId: existing.id, examId: existing.examId }
  }
  const nationalId = normalizeComprehensiveNationalId(app.nationalId)
  if (!/^[A-Za-z0-9]{6,30}$/.test(nationalId)) {
    throw new ComprehensiveExamPhase2Error(400, 'NATIONAL_ID_REQUIRED', 'رقم الهوية مطلوب لمرشح المعادلة — أكمله على الطلب قبل الاعتماد')
  }
  const email = normalizeQualificationEmail(app.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ComprehensiveExamPhase2Error(400, 'INVALID_EMAIL', 'البريد الإلكتروني غير صالح')
  }
  const liveExam =
    (await tx.comprehensiveExam.findFirst({
      where: { programId: app.programId, specializationProgramId: app.specializationProgramId, status: 'READY' },
      select: { id: true, programId: true, specializationProgramId: true },
    })) ||
    (await tx.comprehensiveExam.findFirst({
      where: { programId: app.programId, specializationProgramId: app.specializationProgramId, status: 'DRAFT' },
      select: { id: true, programId: true, specializationProgramId: true },
    }))
  if (!liveExam) {
    throw new ComprehensiveExamPhase2Error(
      409,
      'EXAM_NOT_PREPARED',
      'لا يوجد امتحان شامل لهذا التخصص بعد — أنشئ مسودة الامتحان من تبويب الامتحان الشامل ثم اعتمد الطلب',
    )
  }
  const certificateFile = input.files.find((f) => f.docType === 'FLOW_DOC_1') || input.files[0] || null
  const idFile = input.files.find((f) => f.docType === 'FLOW_DOC_4') || input.files[input.files.length - 1] || null
  if (!certificateFile || !idFile || !certificateFile.storageKey || !idFile.storageKey) {
    throw new ComprehensiveExamPhase2Error(409, 'APPLICATION_FILES_REQUIRED', 'لا توجد مرفقات على الطلب — أرفق الشهادة والهوية أولاً')
  }
  const duplicate = await checkComprehensiveCandidateDuplicate(tx, {
    examId: liveExam.id,
    programId: liveExam.programId,
    specializationProgramId: liveExam.specializationProgramId,
    nationalId,
    email,
  })
  const duplicateError = checkComprehensiveDuplicateError(duplicate)
  if (duplicateError) throw duplicateError
  const candidate = await tx.comprehensiveExamCandidate.create({
    data: {
      examId: liveExam.id,
      userId: app.userId || null,
      admissionApplicationId: app.id,
      fullName: String(app.fullName || '').trim(),
      nationalId,
      email,
      phone: app.phone || null,
      externalCertificateFileKey: certificateFile.storageKey,
      externalCertificateFileName: certificateFile.fileName.slice(0, 180),
      idDocumentFileKey: idFile.storageKey,
      idDocumentFileName: idFile.fileName.slice(0, 180),
      status: 'APPROVED',
      submittedBy: 'CANDIDATE',
      reviewedById: input.admin.id || null,
      reviewedAt: new Date(),
      createdById: input.admin.id || null,
    },
  })
  await tx.auditLog.create({
    data: {
      actorId: input.admin.id || null,
      actorName: input.admin.name || 'النظام',
      action: 'CREATE_COMPREHENSIVE_EXAM_CANDIDATE_FROM_APPLICATION',
      entity: 'ComprehensiveExamCandidate',
      entityId: candidate.id,
      details: `مرشح معادلة من الطلب ${app.id}: ${candidate.fullName} — ${email} — التخصص ${liveExam.specializationProgramId}`,
    },
  })
  return { created: true, candidateId: candidate.id, examId: liveExam.id }
}

// ---- Candidate file upload (admin create route) ----

export type ComprehensiveCandidateParsedForm = {
  fields: Record<string, string>
  certificateFile: File
  idDocumentFile: File
}

// Parses the multipart form. Files are NOT stored here: the caller
// validates the text fields and runs the dedupe checks FIRST, then
// stores the files — so a rejected application leaves no orphaned
// private documents behind.
export async function parseComprehensiveCandidateForm(req: NextRequest): Promise<ComprehensiveCandidateParsedForm> {
  const ct = req.headers.get('content-type') || ''
  if (!ct.includes('multipart/form-data')) {
    throw new ComprehensiveExamPhase2Error(400, 'FORM_REQUIRED', 'أرسل الطلب كنموذج ملفات (multipart)')
  }
  const form = await req.formData()
  const fields: Record<string, string> = {}
  let certificateFile: File | null = null
  let idDocumentFile: File | null = null
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      fields[key] = value
    } else if (value && typeof value === 'object' && 'arrayBuffer' in (value as any)) {
      const file = value as File
      if (key === 'certificateFile') certificateFile = file
      else if (key === 'idDocumentFile') idDocumentFile = file
    }
  }
  if (!certificateFile || !certificateFile.size) {
    throw new ComprehensiveExamPhase2Error(400, 'CERTIFICATE_FILE_REQUIRED', 'ملف الشهادة الخارجية مطلوب')
  }
  if (!idDocumentFile || !idDocumentFile.size) {
    throw new ComprehensiveExamPhase2Error(400, 'ID_FILE_REQUIRED', 'ملف الهوية مطلوب')
  }
  return { fields, certificateFile, idDocumentFile }
}

export type ComprehensiveCandidateStoredFile = {
  fileName: string
  storageKey: string
  mimeType: string
  size: number
}

export async function storeComprehensiveCandidateFile(file: File, label: string): Promise<ComprehensiveCandidateStoredFile> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const checked = validateComprehensiveCandidateFile({ name: file.name, size: file.size, type: file.type, buffer })
  if (!checked.ok) throw new ComprehensiveExamPhase2Error(400, 'INVALID_FILE', checked.error)
  try {
    const stored = await storeFileBuffer({
      buffer,
      fileName: file.name,
      mimeType: checked.mimeType,
      namespace: COMPREHENSIVE_EXAM_CANDIDATE_FILE_NAMESPACE,
    })
    return { fileName: file.name.slice(0, 180), storageKey: stored.key, mimeType: stored.mimeType || checked.mimeType, size: stored.size || file.size }
  } catch (e: any) {
    if (e instanceof ComprehensiveExamPhase2Error) throw e
    throw new ComprehensiveExamPhase2Error(500, 'FILE_STORAGE_FAILED', `تعذر حفظ ملف ${label} — حاول مرة أخرى`)
  }
}
