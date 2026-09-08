import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ADMISSION_FEES } from '@/lib/academyData'
import { getSettingNum, nextInvoiceNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailAdmissionSubmitted } from '@/lib/mailer'

// المستندات الرسمية الإلزامية وفق دليل إجراءات وشروط الالتحاق
// لا يُقبل طلب الالتحاق إلا برفعها كاملة
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
]

// آلة الحالات الرسمية (بالترتيب الصحيح وفق الدليل):
// 1) تقديم الطلب ببيانات كاملة + المستندات + الإقرار
// 2) سداد رسوم التقديم وحجز المقعد 30$ (غير مستردة)
// 3) الملف يذهب للإدارة للدراسة وتعيين مشرف
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
  PENDING: 'تم التقديم',
}

// POST /api/admissions — تقديم طلب التحاق (multipart/form-data)
// الخطوات 1-3 من دليل الإجراءات: بيانات كاملة + رفع الوثائق + الإقرار ثم إصدار فاتورة رسوم التقديم 30$
export async function POST(req: NextRequest) {
  try {
    const ct = req.headers.get('content-type') || ''
    let fields: Record<string, string> = {}
    const files: { docType: string; fileName: string; mimeType: string; size: number; data: string }[] = []

    if (ct.includes('multipart/form-data')) {
      const form = await req.formData()
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') {
          fields[k] = v
        } else if (v && typeof v === 'object' && 'arrayBuffer' in (v as any)) {
          const f = v as File
          if (!f.size) continue
          const docType = k.replace(/^doc_/, '').toUpperCase()
          if (f.size > MAX_FILE_SIZE) {
            return NextResponse.json(
              { error: `حجم ملف «${f.name}» يتجاوز الحد الأقصى 4 ميجابايت — يرجى ضغطه أو تصغيره` },
              { status: 400 }
            )
          }
          const mime = f.type || 'application/octet-stream'
          if (!ALLOWED_MIME.includes(mime)) {
            return NextResponse.json(
              { error: `صيغة ملف «${f.name}» غير مدعومة — المسموح: صور JPG/PNG أو PDF` },
              { status: 400 }
            )
          }
          const buf = Buffer.from(await f.arrayBuffer())
          files.push({ docType, fileName: f.name.slice(0, 180), mimeType: mime, size: f.size, data: buf.toString('base64') })
        }
      }
    } else {
      // توافق خلفي: JSON بدون ملفات (سيُرفض لعدم اكتمال المستندات)
      fields = await req.json()
    }

    const {
      fullName, email, phone, country, nationalId, birthDate, address,
      education, program, programId, notes, acknowledged,
    } = fields

    // ===== الخطوة 1: بيانات كاملة إلزامية =====
    if (!fullName?.trim() || !email?.trim() || !phone?.trim() || !country?.trim() || !program?.trim() || !nationalId?.trim()) {
      return NextResponse.json(
        { error: 'يرجى إكمال جميع حقول البيانات الإلزامية (الاسم، الهوية، البريد، الهاتف، الدولة، البرنامج)' },
        { status: 400 }
      )
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(email.trim())) {
      return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    }

    // ===== الخطوة 2: المستندات الرسمية كاملة إلزامياً =====
    const uploadedTypes = new Set(files.map((f) => f.docType))
    const missing = REQUIRED_DOCS.filter((d) => !uploadedTypes.has(d.type))
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: 'لا يمكن تقديم الطلب: المستندات المطلوبة غير مكتملة. يرجى رفع جميع الوثائق التالية أولاً',
          missing: missing.map((m) => m.label),
        },
        { status: 400 }
      )
    }
    // رفض ملفات مكررة لنفس النوع (نقبل أول واحدة فقط)
    const seen = new Set<string>()
    const uniqueFiles = files.filter((f) => {
      if (seen.has(f.docType)) return false
      seen.add(f.docType)
      return true
    })

    // ===== الخطوة 3: الإقرار الإلزامي =====
    if (acknowledged !== 'true' && acknowledged !== '1') {
      return NextResponse.json(
        { error: 'يجب الموافقة على الإقرار (صحة البيانات والالتزام بشروط الأكاديمية ورسوم التقديم غير مستردة) قبل التقديم' },
        { status: 400 }
      )
    }

    // ربط الطلب بحساب المستخدم إن كان مسجلاً بنفس البريد (توحيد مطابقة البريد lowercase)
    const me = await getCurrentUser()
    const owner = me ? me : await db.user.findUnique({ where: { email: email.trim().toLowerCase() } })

    // البحث عن كائن البرنامج للتسعير والتسجيل النهائي التلقائي
    const programRec = programId
      ? await db.program.findUnique({ where: { id: programId } })
      : await db.program.findFirst({ where: { titleAr: { contains: program.trim().split(' — ')[0] } } })

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

    const app = await db.admissionApplication.create({
      data: {
        reference,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        country: country.trim(),
        nationalId: nationalId.trim().slice(0, 40),
        birthDate: birth,
        address: address?.trim().slice(0, 300) || null,
        education: String(education || 'OTHER'),
        program: programRec?.titleAr || program.trim(),
        programId: programRec?.id || null,
        documents: JSON.stringify(uniqueFiles.map((f) => f.docType)),
        notes: notes?.trim() ? String(notes).slice(0, 2000) : null,
        acknowledged: true,
        acknowledgedAt: new Date(),
        userId: owner?.id || null,
        // الطلب يبدأ بحالة «بانتظار سداد رسوم التقديم» — بعد السداد يُحوَّل تلقائياً للإدارة
        status: 'AWAITING_FEE',
        files: {
          create: uniqueFiles.map((f) => ({
            docType: f.docType,
            fileName: f.fileName,
            mimeType: f.mimeType,
            size: f.size,
            data: f.data,
          })),
        },
      },
    })

    // ===== الخطوة 4: فاتورة رسوم التقديم وحجز المقعد (30$ غير مستردة) فور التقديم =====
    const appFee = await getSettingNum('FEE_APPLICATION')
    const feeInvoice = await db.payment.create({
      data: {
        admissionId: app.id,
        userId: owner?.id || null,
        invoiceNo: await nextInvoiceNo(),
        purpose: 'APPLICATION_FEE',
        description: `رسوم التقديم وحجز المقعد (غير مستردة) — ${programRec?.titleAr || program.trim()}`,
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
        'تم استلام طلب الالتحاق — سدد رسوم التقديم (30$)',
        `طلبك (${reference}) ببرنامج «${programRec?.titleAr || program.trim()}» مكتمل بالبيانات والمستندات (${uniqueFiles.length}/4) والإقرار. سدد رسوم التقديم وحجز المقعد ${appFee}$ (غير مستردة) ليُحوَّل ملفك للإدارة للدراسة ويعطيك إشعار القبول.`,
        'apply'
      )
    }
    // إشعار بريدي بكود التتبع وخطوات ما بعد التقديم
    emailAdmissionSubmitted(email.trim(), fullName.trim(), reference, programRec?.titleAr || program.trim(), appFee).catch(() => {})
    await audit(
      owner ? { id: owner.id, name: owner.name } : { name: fullName.trim() },
      'SUBMIT_ADMISSION',
      'AdmissionApplication',
      app.id,
      `${reference} — ${programRec?.titleAr || program.trim()} — مستندات: ${uniqueFiles.length}/4 + إقرار — فاتورة رسوم تقديم ${appFee}$`
    )

    return NextResponse.json({
      message: `تم استلام طلبك مع البيانات الكاملة والمستندات (${uniqueFiles.length}/4) والإقرار! كود تتبع طلبك: ${reference} — سدد رسوم التقديم (${appFee}$) ليُحوَّل ملفك للإدارة`,
      reference: app.reference,
      applicationFee: ADMISSION_FEES.applicationFee,
      documentsCount: uniqueFiles.length,
      invoice: {
        invoiceNo: feeInvoice.invoiceNo,
        amount: feeInvoice.amount,
        purpose: feeInvoice.purpose,
        description: feeInvoice.description,
      },
    })
  } catch (e: any) {
    console.error('admissions POST error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء تقديم الطلب، حاول مرة أخرى' }, { status: 500 })
  }
}

// GET /api/admissions?ref=AACT-2026-1234 — تتبع طلب بالكود المرجعي
export async function GET(req: NextRequest) {
  try {
    const ref = req.nextUrl.searchParams.get('ref')?.trim()
    if (!ref) {
      return NextResponse.json({ error: 'يرجى إدخال كود التتبع' }, { status: 400 })
    }
    const app = await db.admissionApplication.findUnique({
      where: { reference: ref },
      include: {
        supervisor: { select: { name: true } },
        files: { select: { id: true, docType: true, fileName: true, size: true } },
        payments: {
          select: {
            invoiceNo: true, purpose: true, amount: true, status: true,
            description: true, receiptNo: true, paidAt: true, createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!app) {
      return NextResponse.json({ error: 'لا يوجد طلب بهذا الكود المرجعي' }, { status: 404 })
    }
    return NextResponse.json({
      application: {
        reference: app.reference,
        fullName: app.fullName,
        program: app.program,
        status: app.status,
        statusLabel: STATUS_LABEL[app.status] || app.status,
        supervisorName: app.supervisor?.name || null,
        thesisDeadline: app.thesisDeadline,
        createdAt: app.createdAt,
        documents: app.files.map((f) => ({ id: f.id, docType: f.docType, fileName: f.fileName, size: f.size })),
        payments: app.payments,
      },
    })
  } catch (e: any) {
    console.error('admissions GET error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء البحث عن الطلب' }, { status: 500 })
  }
}
