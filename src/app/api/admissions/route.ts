import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ACADEMY_INFO, ADMISSION_FEES } from '@/lib/academyData'
import { getSettingNum, nextInvoiceNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailAdminNewAdmissionRequest, emailAdmissionSubmitted, emailServiceRequestSubmitted } from '@/lib/mailer'
import { getStorageDownloadPathForKey, storageErrorMessage, storeFileBuffer } from '@/lib/storage'
import { clientIpFromHeaders, enforceApiRateLimit } from '@/lib/rate-limit'
import { buildServiceAdmissionDefaults, getServiceFlow } from '@/lib/service-flows'
import { REQUIRED_ADMISSION_DOCS, resolveAdmissionRequiredDocuments } from '@/lib/admission-required-documents'
import { resolveRules } from '@/lib/admission-ai'
import { deriveServiceWorkflowState } from '@/lib/service-workflows'
import { createAdmissionUploadToken } from '@/lib/admission-upload-token'
import { normalizePhone, isSupportedCountry, validateApplicantFullName, validateBirthDateForMinAge, validateNationalIdOrPassport, validatePhone } from '@/lib/admission-validation'
import { inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'
import { extractAdmissionDocumentReplacement } from '@/lib/admission-document-replacement'
import { repairVerifiedStudentRecordOwnership, studentAdmissionOwnershipWhere, studentOwnsAdmission } from '@/lib/student-record-ownership'
import { validateAdmissionFileSignature } from '@/lib/file-signature'
import { dollarsToCents } from '@/lib/money'
import { withTimedResponse, withTiming } from '@/lib/timing'

// المستندات الرسمية الإلزامية وفق دليل إجراءات وشروط الالتحاق.
// المصدر التنفيذي المشترك مع ApplyView موجود في src/lib/admission-required-documents.ts.
export const REQUIRED_DOCS = REQUIRED_ADMISSION_DOCS

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB لكل ملف
const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain', 'text/csv', 'application/csv',
]

type UploadedAdmissionFile = {
  docType: string
  fileName: string
  mimeType: string
  size: number
  data: string | null
  storageProvider: string | null
  storageKey: string | null
  fileUrl: string | null
}

// آلة الحالات الرسمية (بالترتيب الصحيح وفق الدليل):
// 1) تقديم الطلب ببيانات كاملة + المستندات + الإقرار
// 2) سداد رسوم التقديم وحجز المقعد 30$ (غير مستردة) للبرامج الدراسية
// 3) الملف يذهب للإدارة للدراسة وتعيين مشرف أو متابعة خدمة مهنية
// 4) بعد موافقة الإدارة: يسدد الطالب الرسوم الدراسية كاملة للدخول للبرنامج
export const STATUS_LABEL: Record<string, string> = {
  AWAITING_FEE: 'بانتظار سداد رسوم التقديم (30$)',
  UNDER_REVIEW: 'قيد دراسة الإدارة',
  DOCUMENTS_NEED_REPLACEMENT: 'مطلوب استبدال مستندات',
  AWAITING_TUITION: 'مقبول — بانتظار سداد الرسوم الدراسية',
  SUPERVISOR_ASSIGNED: 'تم تعيين مشرف',
  THESIS: 'التسجيل النهائي — قيد إعداد بحث التخرج',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'غير مقبول',
  UPLOADING_DOCUMENTS: 'جاري رفع المستندات',
  PENDING: 'تم التقديم',
}

function normalizeDocType(key: string) {
  return key.replace(/^doc_/, '').toUpperCase().slice(0, 40)
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function validEmail(value?: string | null) {
  const email = String(value || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function digitsOnly(value?: string | null) {
  return String(value || '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/\D/g, '')
}

function strongAdmissionReference() {
  // 128-bit random suffix. نحافظ على بادئة AACT-2026 حتى تبقى الأكواد مفهومة للطالب والإدارة.
  return `AACT-2026-${randomBytes(16).toString('hex').toUpperCase()}`
}

function trackingVerifierMatches(app: { email?: string | null; phone?: string | null }, emailInput?: string | null, phoneLast4Input?: string | null) {
  const email = validEmail(emailInput)
  const submittedLast4 = digitsOnly(phoneLast4Input).slice(-4)
  const appPhoneLast4 = digitsOnly(app.phone).slice(-4)
  if (!email || submittedLast4.length !== 4 || appPhoneLast4.length !== 4) return false
  return email === String(app.email || '').trim().toLowerCase() && submittedLast4 === appPhoneLast4
}

async function adminAdmissionEmailRecipients() {
  const adminUsers = await withTiming('db_admissions_admin_email_recipients', () => db.user.findMany({
    where: { role: 'ADMIN' },
    select: { email: true },
    take: 20,
  }).catch(() => []))
  const candidates = [
    ...adminUsers.map((u) => u.email),
    process.env.ADMIN_EMAIL,
    process.env.E2E_ADMIN_EMAIL,
    ACADEMY_INFO.email,
  ]
  return Array.from(new Set(candidates.map(validEmail).filter(Boolean)))
}

async function readAdmissionPayload(req: NextRequest) {
  const ct = req.headers.get('content-type') || ''
  let fields: Record<string, string> = {}
  const files: UploadedAdmissionFile[] = []

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData()
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') {
        fields[k] = v
      } else if (v && typeof v === 'object' && 'arrayBuffer' in (v as any)) {
        const f = v as File
        if (!f.size) continue
        const docType = normalizeDocType(k)
        if (f.size > MAX_FILE_SIZE) {
          throw jsonError(`حجم ملف «${f.name}» يتجاوز الحد الأقصى 4 ميجابايت — يرجى ضغطه أو تصغيره`)
        }
        const mime = f.type || 'application/octet-stream'
        const nameOk = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|xls|txt|csv)$/i.test(f.name)
        if (!ALLOWED_MIME.includes(mime) && !nameOk) {
          throw jsonError(`صيغة ملف «${f.name}» غير مدعومة — المسموح: صور JPG/PNG/WebP/HEIC أو PDF أو Word DOCX أو Excel XLSX أو TXT/CSV`)
        }

        const buf = Buffer.from(await f.arrayBuffer())
        const signature = validateAdmissionFileSignature({ buffer: buf, fileName: f.name, mimeType: mime })
        if (!signature.ok) {
          throw jsonError(`تم رفض ملف «${f.name}»: ${signature.error}`)
        }

        let stored
        try {
          stored = await storeFileBuffer({
            buffer: buf,
            fileName: f.name,
            mimeType: signature.mimeType,
            namespace: `admissions/${docType.toLowerCase()}`,
          })
        } catch (error) {
          throw jsonError(storageErrorMessage(error), 500)
        }

        files.push({
          docType,
          fileName: f.name.slice(0, 180),
          mimeType: stored.mimeType || signature.mimeType,
          size: stored.size || f.size,
          data: null,
          storageProvider: stored.provider,
          storageKey: stored.key,
          fileUrl: stored.url,
        })
      }
    }
  } else {
    fields = await req.json()
  }

  return { fields, files }
}

function uniqueAdmissionFiles(files: UploadedAdmissionFile[]) {
  const seen = new Set<string>()
  return files.filter((f) => {
    if (!f.docType || seen.has(f.docType)) return false
    seen.add(f.docType)
    return true
  })
}

// POST /api/admissions — تقديم طلب التحاق أو طلب خدمة مهنية (multipart/form-data)
export async function POST(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    const submitLimit = enforceApiRateLimit(req, 'admissions:submit', 8, 60 * 60 * 1000, clientIpFromHeaders(req.headers))
    if (submitLimit) return submitLimit

    const { fields, files } = await readAdmissionPayload(req)
    const { fullName, email, phone, country, nationalId, birthDate, address, education, program, programId, notes, acknowledged } = fields
    const stagedUpload = fields.stagedUpload === 'true' || fields.stagedUpload === '1'

    if (!fullName?.trim() || !email?.trim() || !phone?.trim() || !country?.trim() || !program?.trim()) {
      return NextResponse.json({ error: 'يرجى إكمال جميع حقول البيانات الإلزامية (الاسم، البريد، الهاتف، الدولة، البرنامج أ[...]
    }
    const submittedEmail = email.trim().toLowerCase()
    if (!validEmail(submittedEmail)) return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    const nameError = validateApplicantFullName(fullName, 3)
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 })
    const phoneError = validatePhone(phone)
    if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 })
    if (!isSupportedCountry(country)) return NextResponse.json({ error: 'يرجى اختيار الدولة من القائمة المعتمدة بدلاً من كتابتها يدوياً.' },[...]

    const requestedProgramTitle = program.trim().split(' — ')[0].trim()
    const programRec = await withTiming('db_admissions_program_lookup', () => programId
      ? db.program.findFirst({ where: { id: programId, active: true } })
      : db.program.findFirst({ where: { titleAr: requestedProgramTitle, active: true } }))
    if (!programRec) return NextResponse.json({ error: 'البرنامج أو الخدمة المحددة غير موجودة أو غير متاحة حالياً. يرجى العودة إلى �[...]

    const serviceFlow = getServiceFlow(programRec.slug)
    const isServiceRequest = serviceFlow ? !serviceFlow.isStudyProgram : programRec.category === 'SERVICE'
    const programRules = programRec.admissionRules
      ? resolveRules(programRec.category || 'DIPLOMA', programRec.admissionRules, !isServiceRequest)
      : (buildServiceAdmissionDefaults(serviceFlow) || resolveRules(programRec.category || 'DIPLOMA', programRec.admissionRules, !isServiceRequest))

    if (!isServiceRequest) {
      const nationalError = validateNationalIdOrPassport(String(nationalId || ''), country)
      if (nationalError) return NextResponse.json({ error: nationalError }, { status: 400 })
      if (programRules?.minAge) {
        const birthError = validateBirthDateForMinAge(String(birthDate || ''), Number(programRules.minAge))
        if (birthError) return NextResponse.json({ error: birthError }, { status: 400 })
      }
    }

    const uploadedTypes = new Set(files.map((f) => f.docType))
    const { requiredDocs: requiredDocList } = resolveAdmissionRequiredDocuments({ slug: programRec.slug, category: programRec.category, admissionRules: programRules, isServiceRequest })
    const missing = stagedUpload ? [] : requiredDocList.filter((d) => !uploadedTypes.has(d.type))
    if (missing.length > 0) {
      return NextResponse.json({ error: isServiceRequest ? 'لا يمكن تقديم طلب الخدمة: المرفقات المطلوبة لهذه الخدمة غير مكتملة' : 'لا ي[...]
    }
    const uniqueFiles = uniqueAdmissionFiles(files)
    if (acknowledged !== 'true' && acknowledged !== '1') return NextResponse.json({ error: 'يجب الموافقة على الإقرار (صحة البيانات والالتزام بشروط [...]

    const me = await withTiming('db_admissions_current_user', () => getCurrentUser())
    if (me && me.role !== 'STUDENT') return NextResponse.json({ error: 'حساب الإدارة أو المشرف لا يقدم طلب التحاق كطالب. استخدم حساب طالب م[...]
    if (me?.role === 'STUDENT') {
      if (!(me as any).emailVerifiedAt) return NextResponse.json({ error: 'يجب تأكيد البريد الإلكتروني قبل تقديم طلب التحاق أو خدمة.' }, { status:[...]
      if (submittedEmail !== String(me.email || '').trim().toLowerCase()) return NextResponse.json({ error: 'بريد الطلب يجب أن يطابق بريد حساب الطالب المؤك[...]
    }
    const owner = me ? me : await withTiming('db_admissions_user_by_email', () => db.user.findUnique({ where: { email: submittedEmail } }))
    if (owner && owner.role !== 'STUDENT') return NextResponse.json({ error: 'البريد المدخل مرتبط بحساب إداري/غير طالب. أنشئ حساب طالب منفصل �[...]

    let reference = ''
    for (let i = 0; i < 5; i++) {
      reference = strongAdmissionReference()
      const exists = await withTiming('db_admissions_reference_exists', () => db.admissionApplication.findUnique({ where: { reference } }))
      if (!exists) break
    }
    let birth: Date | null = null
    if (birthDate) {
      const d = new Date(birthDate)
      if (!isNaN(d.getTime())) birth = d
    }
    const selectedTitle = programRec.titleAr || program.trim()
    const app = await withTiming('db_admissions_application_create', () => db.admissionApplication.create({
      data: {
        reference, fullName: fullName.trim(), email: submittedEmail, phone: normalizePhone(phone), country: country.trim(),
        nationalId: String(nationalId || '').trim() ? String(nationalId).trim().slice(0, 40) : null,
        birthDate: birth, address: address?.trim().slice(0, 300) || null, education: String(education || 'OTHER'), program: selectedTitle,
        programId: programRec.id, documents: JSON.stringify(uniqueFiles.map((f) => f.docType)), notes: notes?.trim() ? String(notes).slice(0, 2000) : null,
        acknowledged: true, acknowledgedAt: new Date(), userId: owner?.id || null, status: stagedUpload ? 'UPLOADING_DOCUMENTS' : (isServiceRequest ? 'UNDER_REVIEW' : 'AWAITING_FEE'),
        files: { create: uniqueFiles.map((f) => ({ docType: f.docType, fileName: f.fileName, mimeType: f.mimeType, size: f.size, data: f.data, storageProvider: f.storageProvider, storageKe[...]