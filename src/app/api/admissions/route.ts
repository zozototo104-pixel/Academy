import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ADMISSION_FEES } from '@/lib/academyData'
import { getSettingNum, nextInvoiceNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailAdmissionSubmitted, emailServiceRequestSubmitted } from '@/lib/mailer'
import { storageErrorMessage, storeFileBuffer } from '@/lib/storage'
import { clientIpFromHeaders, enforceApiRateLimit } from '@/lib/rate-limit'
import { buildServiceAdmissionDefaults, getServiceDocumentOptions, getServiceFlow } from '@/lib/service-flows'
import { resolveRules } from '@/lib/admission-ai'
import { deriveServiceWorkflowState } from '@/lib/service-workflows'
import { createAdmissionUploadToken } from '@/lib/admission-upload-token'
import { normalizePhone, isSupportedCountry, validateApplicantFullName, validateBirthDateForMinAge, validateNationalIdOrPassport, validatePhone } from '@/lib/admission-validation'

// المستندات الرسمية الإلزامية وفق دليل إجراءات وشروط الالتحاق
// لا يُقبل طلب الالتحاق الدراسي إلا برفعها كاملة. أما الخدمات المهنية فتقبل مرفقات داعمة اختيارية.
export const REQUIRED_DOCS: { type: string; label: string }[] = [
  { type: 'DEGREE', label: 'صورة عن الشهادة الجامعية وكشف العلامات (أو الثانوية للدبلومات)' },
  { type: 'ID', label: 'صورة عن الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة' },
  { type: 'CV', label: 'صورة عن السيرة الذاتية (C.V)' },
]

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
        let stored
        try {
          stored = await storeFileBuffer({
            buffer: buf,
            fileName: f.name,
            mimeType: mime,
            namespace: `admissions/${docType.toLowerCase()}`,
          })
        } catch (error) {
          throw jsonError(storageErrorMessage(error), 500)
        }

        files.push({
          docType,
          fileName: f.name.slice(0, 180),
          mimeType: stored.mimeType || mime,
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
  try {
    const submitLimit = enforceApiRateLimit(req, 'admissions:submit', 8, 60 * 60 * 1000, clientIpFromHeaders(req.headers))
    if (submitLimit) return submitLimit

    const { fields, files } = await readAdmissionPayload(req)
    const {
      fullName, email, phone, country, nationalId, birthDate, address,
      education, program, programId, notes, acknowledged,
    } = fields
    const stagedUpload = fields.stagedUpload === 'true' || fields.stagedUpload === '1'

    // ===== الخطوة 1: بيانات أساسية إلزامية =====
    if (!fullName?.trim() || !email?.trim() || !phone?.trim() || !country?.trim() || !program?.trim()) {
      return NextResponse.json(
        { error: 'يرجى إكمال جميع حقول البيانات الإلزامية (الاسم، البريد، الهاتف، الدولة، البرنامج أو الخدمة)' },
        { status: 400 }
      )
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(email.trim())) {
      return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    }
    const nameError = validateApplicantFullName(fullName, 3)
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 })
    const phoneError = validatePhone(phone)
    if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 })
    if (!isSupportedCountry(country)) {
      return NextResponse.json({ error: 'يرجى اختيار الدولة من القائمة المعتمدة بدلاً من كتابتها يدوياً.' }, { status: 400 })
    }

    // البحث عن البرنامج/الخدمة قبل فحص الهوية والمستندات حتى نفرق بين طلب الدراسة وطلب الخدمة المهنية.
    const programRec = programId
      ? await db.program.findUnique({ where: { id: programId } })
      : await db.program.findFirst({ where: { titleAr: { contains: program.trim().split(' — ')[0] } } })
    const serviceFlow = getServiceFlow(programRec?.slug)
    const isServiceRequest = serviceFlow ? !serviceFlow.isStudyProgram : programRec?.category === 'SERVICE'
    const programRules = programRec?.admissionRules
      ? resolveRules(programRec?.category || 'DIPLOMA', programRec.admissionRules, !isServiceRequest)
      : (buildServiceAdmissionDefaults(serviceFlow) || resolveRules(programRec?.category || 'DIPLOMA', programRec?.admissionRules, !isServiceRequest))

    if (!isServiceRequest) {
      const nationalError = validateNationalIdOrPassport(String(nationalId || ''), country)
      if (nationalError) return NextResponse.json({ error: nationalError }, { status: 400 })
      if (programRules?.minAge) {
        const birthError = validateBirthDateForMinAge(String(birthDate || ''), Number(programRules.minAge))
        if (birthError) return NextResponse.json({ error: birthError }, { status: 400 })
      }
    }

    // ===== الخطوة 2: المستندات الرسمية أو مرفقات الخدمة المخصصة =====
    const uploadedTypes = new Set(files.map((f) => f.docType))
    const rules = programRules
    const serviceDocMap = new Map(getServiceDocumentOptions(serviceFlow).map((d) => [d.type, d.label]))
    const requiredDocList = isServiceRequest
      ? (rules.requiredDocuments || []).map((type) => ({ type, label: serviceDocMap.get(type) || type }))
      : REQUIRED_DOCS
    const missing = stagedUpload ? [] : requiredDocList.filter((d) => !uploadedTypes.has(d.type))
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: isServiceRequest ? 'لا يمكن تقديم طلب الخدمة: المرفقات المطلوبة لهذه الخدمة غير مكتملة' : 'لا يمكن تقديم الطلب: المستندات المطلوبة غير مكتملة. يرجى رفع جميع الوثائق التالية أولاً',
          missing: missing.map((m) => m.label),
        },
        { status: 400 }
      )
    }
    const uniqueFiles = uniqueAdmissionFiles(files)

    // ===== الخطوة 3: الإقرار الإلزامي =====
    if (acknowledged !== 'true' && acknowledged !== '1') {
      return NextResponse.json(
        { error: 'يجب الموافقة على الإقرار (صحة البيانات والالتزام بشروط الأكاديمية ورسوم التقديم غير مستردة) قبل التقديم' },
        { status: 400 }
      )
    }

    // ربط الطلب بحساب المستخدم إن كان مسجلاً بنفس البريد. حسابات الإدارة/المشرفين لا تقدم كطلاب.
    const me = await getCurrentUser()
    if (me && me.role !== 'STUDENT') {
      return NextResponse.json(
        { error: 'حساب الإدارة أو المشرف لا يقدم طلب التحاق كطالب. استخدم حساب طالب منفصل ببريد الطالب الحقيقي، ويمكن للإدارة متابعة الطالب من صفحة معاينة طالب.' },
        { status: 403 }
      )
    }
    const owner = me ? me : await db.user.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (owner && owner.role !== 'STUDENT') {
      return NextResponse.json(
        { error: 'البريد المدخل مرتبط بحساب إداري/غير طالب. أنشئ حساب طالب منفصل أو استخدم بريد الطالب الحقيقي قبل تقديم الطلب.' },
        { status: 400 }
      )
    }

    // كود تتبع حالة الطلب AACT-2026-XXXX (15 محاولة لتفادي التصادم)
    let reference = ''
    for (let i = 0; i < 15; i++) {
      const num = Math.floor(1000 + Math.random() * 9000)
      reference = `AACT-2026-${num}`
      const exists = await db.admissionApplication.findUnique({ where: { reference } })
      if (!exists) break
    }

    let birth: Date | null = null
    if (birthDate) {
      const d = new Date(birthDate)
      if (!isNaN(d.getTime())) birth = d
    }

    const selectedTitle = programRec?.titleAr || program.trim()
    const app = await db.admissionApplication.create({
      data: {
        reference,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: normalizePhone(phone),
        country: country.trim(),
        nationalId: String(nationalId || '').trim() ? String(nationalId).trim().slice(0, 40) : null,
        birthDate: birth,
        address: address?.trim().slice(0, 300) || null,
        education: String(education || 'OTHER'),
        program: selectedTitle,
        programId: programRec?.id || null,
        documents: JSON.stringify(uniqueFiles.map((f) => f.docType)),
        notes: notes?.trim() ? String(notes).slice(0, 2000) : null,
        acknowledged: true,
        acknowledgedAt: new Date(),
        userId: owner?.id || null,
        status: stagedUpload ? 'UPLOADING_DOCUMENTS' : (isServiceRequest ? 'UNDER_REVIEW' : 'AWAITING_FEE'),
        files: {
          create: uniqueFiles.map((f) => ({
            docType: f.docType,
            fileName: f.fileName,
            mimeType: f.mimeType,
            size: f.size,
            data: f.data,
            storageProvider: f.storageProvider,
            storageKey: f.storageKey,
            fileUrl: f.fileUrl,
          })),
        },
      },
    })

    if (stagedUpload) {
      return NextResponse.json({
        message: 'تم إنشاء الطلب المؤقت. ارفع المستندات الآن ملفاً ملفاً ثم أكمل التقديم.',
        reference: app.reference,
        applicationId: app.id,
        uploadToken: createAdmissionUploadToken(app),
        staged: true,
        documentsCount: uniqueFiles.length,
      })
    }

    // البرامج الدراسية لها فاتورة رسوم تقديم، أما الخدمات المهنية فتدخل مباشرة للمراجعة.
    const appFee = isServiceRequest ? 0 : await getSettingNum('FEE_APPLICATION')
    const feeInvoice = isServiceRequest ? null : await db.payment.create({
      data: {
        admissionId: app.id,
        userId: owner?.id || null,
        invoiceNo: await nextInvoiceNo(),
        purpose: 'APPLICATION_FEE',
        description: `رسوم التقديم وحجز المقعد (غير مستردة) — ${selectedTitle}`,
        amount: appFee,
        payerName: fullName.trim(),
        payerEmail: email.trim(),
        payerCountry: country.trim(),
      },
    })

    if (owner) {
      await notify(
        owner.id,
        'ADMISSION',
        isServiceRequest ? 'تم استلام طلب الخدمة — قيد دراسة الإدارة' : 'تم استلام طلب الالتحاق — سدد رسوم التقديم (30$)',
        isServiceRequest
          ? `طلبك (${reference}) لخدمة «${selectedTitle}» وصل للإدارة مع ${uniqueFiles.length} ملف/مرفق. ستصلك تعليمات المتابعة أو التسعير أو الموعد بعد المراجعة.`
          : `طلبك (${reference}) ببرنامج «${selectedTitle}» مكتمل بالبيانات والمستندات (${uniqueFiles.length}/4) والإقرار. سدد رسوم التقديم وحجز المقعد ${appFee}$ (غير مستردة) ليُحوَّل ملفك للإدارة للدراسة ويعطيك إشعار القبول.`,
        'apply'
      )
    }

    // إشعار بريدي بكود التتبع وخطوات ما بعد التقديم للبرامج الدراسية؛ الخدمات تُراجع أولاً لتحديد المتطلبات.
    if (isServiceRequest) {
      emailServiceRequestSubmitted(email.trim(), fullName.trim(), reference, selectedTitle).catch(() => {})
    } else {
      emailAdmissionSubmitted(email.trim(), fullName.trim(), reference, selectedTitle, appFee).catch(() => {})
    }
    await audit(
      owner ? { id: owner.id, name: owner.name } : { name: fullName.trim() },
      isServiceRequest ? 'SUBMIT_SERVICE_REQUEST' : 'SUBMIT_ADMISSION',
      'AdmissionApplication',
      app.id,
      isServiceRequest
        ? `${reference} — طلب خدمة: ${selectedTitle} — مرفقات: ${uniqueFiles.length} + إقرار`
        : `${reference} — ${selectedTitle} — مستندات: ${uniqueFiles.length}/4 + إقرار — فاتورة رسوم تقديم ${appFee}$`
    )

    return NextResponse.json({
      message: isServiceRequest
        ? `تم استلام طلب الخدمة! كود التتبع: ${reference} — ستقوم الإدارة بمراجعة الطلب وتحديد الخطوة التالية`
        : `تم استلام طلبك مع البيانات الكاملة والمستندات (${uniqueFiles.length}/4) والإقرار! كود تتبع طلبك: ${reference} — سدد رسوم التقديم (${appFee}$) ليُحوَّل ملفك للإدارة`,
      reference: app.reference,
      applicationFee: isServiceRequest ? 0 : ADMISSION_FEES.applicationFee,
      documentsCount: uniqueFiles.length,
      invoice: feeInvoice ? {
        invoiceNo: feeInvoice.invoiceNo,
        amount: feeInvoice.amount,
        purpose: feeInvoice.purpose,
        description: feeInvoice.description,
      } : null,
    })
  } catch (e: any) {
    if (e instanceof Response) return e
    console.error('admissions POST error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء تقديم الطلب، حاول مرة أخرى' }, { status: 500 })
  }
}

// GET /api/admissions?ref=AACT-2026-1234 — تتبع طلب بالكود المرجعي
// GET /api/admissions?mine=1 — آخر طلبات الطالب الحالي بدون إدخال كود التتبع
export async function GET(req: NextRequest) {
  try {
    const ref = req.nextUrl.searchParams.get('ref')?.trim()
    const mine = req.nextUrl.searchParams.get('mine') === '1'
    const include: any = {
      supervisor: { select: { name: true } },
      programRef: { select: { slug: true, category: true, titleAr: true } },
      files: { select: { id: true, docType: true, fileName: true, size: true } },
      payments: {
        select: {
          invoiceNo: true, purpose: true, amount: true, status: true,
          description: true, receiptNo: true, paidAt: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' as const },
      },
      theses: {
        select: { id: true, title: true, status: true, createdAt: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' as const },
      },
      deliverables: {
        select: { id: true, type: true, status: true, visibleToStudent: true, title: true, createdAt: true },
        orderBy: { createdAt: 'desc' as const },
      },
    }
    const serialize = (app: any) => {
      const flow = getServiceFlow(app.programRef?.slug)
      const isStudyProgram = flow ? flow.isStudyProgram : app.programRef?.category !== 'SERVICE'
      const requestKind = flow?.kind || (isStudyProgram ? 'DEGREE_STUDY' : 'SERVICE_REQUEST')
      const serviceWorkflow = isStudyProgram ? null : deriveServiceWorkflowState({
        kind: requestKind,
        status: app.status,
        payments: app.payments,
        deliverables: app.deliverables,
      })
      return {
      reference: app.reference,
      fullName: app.fullName,
      program: app.program,
      programSlug: app.programRef?.slug || null,
      requestKind,
      requestLabel: flow?.title || (isStudyProgram ? 'طلب التحاق دراسي' : 'طلب خدمة مهنية'),
      isStudyProgram,
      serviceWorkflow,
      status: app.status,
      statusLabel: STATUS_LABEL[app.status] || app.status,
      supervisorName: app.supervisor?.name || null,
      thesisDeadline: app.thesisDeadline,
      createdAt: app.createdAt,
      email: app.email,
      phone: app.phone,
      documents: (app.files || []).map((f: any) => ({ id: f.id, docType: f.docType, fileName: f.fileName, size: f.size })),
      payments: app.payments || [],
      theses: app.theses || [],
      nextAction: !isStudyProgram && serviceWorkflow
        ? serviceWorkflow.clientNextAction
        : app.status === 'AWAITING_FEE'
            ? (isStudyProgram ? 'سداد رسوم التقديم وحجز المقعد حتى ينتقل الملف للإدارة.' : 'سداد رسوم فتح الطلب حتى ينتقل ملف الخدمة للإدارة.')
            : app.status === 'UNDER_REVIEW'
              ? 'ملفك قيد دراسة الإدارة. ستصلك رسالة عند صدور قرار القبول أو تعليمات المتابعة.'
              : app.status === 'AWAITING_TUITION'
                ? 'تمت الموافقة المبدئية. يرجى سداد الرسوم الدراسية لاستكمال التسجيل النهائي والدخول للبرنامج.'
                : app.status === 'SUPERVISOR_ASSIGNED' || app.status === 'THESIS'
                  ? 'تم تفعيل قيدك الدراسي. يمكنك متابعة البرنامج من بوابة الطالب.'
                  : app.status === 'REJECTED'
                    ? 'تم رفض الطلب. يمكنك التواصل مع الإدارة لمعرفة السبب أو تقديم طلب جديد عند السماح.'
                    : isStudyProgram
                      ? 'تابع تعليمات الإدارة في بوابة الطالب.'
                      : 'تابع تعليمات الإدارة بشأن طلب الخدمة والمرفقات أو الموعد أو التسعير.',
      }
    }

    if (mine) {
      const user = await getCurrentUser()
      if (!user) return NextResponse.json({ applications: [], application: null })
      if (user.role === 'SUPERVISOR') {
        const apps = await db.admissionApplication.findMany({
          where: { supervisorId: user.id },
          orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
          take: 50,
          include,
        })
        const serialized = apps.map(serialize)
        return NextResponse.json({ applications: serialized, application: serialized[0] || null, supervisorMode: true })
      }
      if (user.role !== 'STUDENT') {
        return NextResponse.json({ applications: [], application: null, restricted: true, reason: 'طلبات الالتحاق والخدمات تخص حسابات الطلاب/المتقدمين فقط.' })
      }
      const apps = await db.admissionApplication.findMany({
        where: { OR: [{ userId: user.id }, { email: user.email }] },
        orderBy: [{ createdAt: 'desc' }],
        take: 10,
        include,
      })
      const serialized = apps.map(serialize)
      return NextResponse.json({ applications: serialized, application: serialized[0] || null })
    }

    if (!ref) {
      return NextResponse.json({ error: 'يرجى إدخال كود التتبع' }, { status: 400 })
    }

    const trackLimit = enforceApiRateLimit(req, 'admissions:track', 12, 10 * 60 * 1000, ref)
    if (trackLimit) return trackLimit

    const app = await db.admissionApplication.findUnique({
      where: { reference: ref },
      include,
    })
    if (!app) {
      return NextResponse.json({ error: 'لا يوجد طلب بهذا الكود المرجعي' }, { status: 404 })
    }
    return NextResponse.json({ application: serialize(app) })
  } catch (e: any) {
    console.error('admissions GET error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء البحث عن الطلب' }, { status: 500 })
  }
}
