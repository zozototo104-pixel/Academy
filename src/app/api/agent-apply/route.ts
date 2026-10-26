import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { nextInvoiceNo, getSettingNum, getSettingJson } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailAgentInvoice } from '@/lib/mailer'
import { resolveAgentRequiredDocuments } from '@/lib/admission-required-documents'
import { storageErrorMessage, storeFileBuffer } from '@/lib/storage'

// POST /api/agent-apply — طلب وكالة (للشركات والمؤسسات) أو طلب اعتماد (للأفراد:
// مستشار/مدرب/جودة). المرفقات الإلزامية لا تأتي من الكود بل من قواعد
// الوكالة والاعتماد (تبويب قواعد القبول) — قائمة مشتركة للنوعين، وتفعيل
// وثيقة يجعلها إجبارية عند التقديم. ورسوم التقديم (غير مستردة) تُنشأ
// فور التقديم لكلا النوعين من الإعدادات، والقبول مقفول حتى سدادها.

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf']

// GET /api/agent-apply — قائمة مرفقات الوكالة/الاعتماد ورسوم التقديم
// للنموذج العام (معلومة عامة، لا أسرار فيها).
export async function GET() {
  try {
    const raw = await getSettingJson('AGENT_ADMISSION_RULES', null)
    const { requiredDocs } = resolveAgentRequiredDocuments(raw)
    return NextResponse.json({
      docs: requiredDocs,
      agencyFee: await getSettingNum('FEE_AGENCY_APPLICATION'),
      accreditationFee: await getSettingNum('FEE_ACC_APPLICATION'),
      categoryFees: {
        COMPANY: await getSettingNum('FEE_ACC_COMPANY'),
        CONSULTANT: await getSettingNum('FEE_ACC_CONSULTANT'),
        TRAINER: await getSettingNum('FEE_ACC_TRAINER'),
        QUALITY: await getSettingNum('FEE_ACC_QUALITY'),
      },
    })
  } catch {
    return NextResponse.json({ docs: [], agencyFee: 0, accreditationFee: 0, categoryFees: {} })
  }
}

type UploadedAgentFile = {
  docType: string
  fileName: string
  mimeType: string
  size: number
  data: string | null
  storageProvider: string | null
  storageKey: string | null
  fileUrl: string | null
}

export async function POST(req: NextRequest) {
  try {
    let fields: Record<string, string> = {}
    const files: UploadedAgentFile[] = []
    const ct = req.headers.get('content-type') || ''

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
          let stored
          try {
            stored = await storeFileBuffer({
              buffer: buf,
              fileName: f.name,
              mimeType: mime,
              namespace: `agent-documents/${docType.toLowerCase()}`,
            })
          } catch (error) {
            return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
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

    const { kind, accreditationType, orgName, repName, email, phone, country, territory, experience } = fields
    const isAccreditation = kind === 'ACCREDITATION'
    // الاعتماد للأفراد فقط: مستشار/مدرب/جودة — الشركات تتقدم عبر مسار الوكالة.
    const validAccTypes = ['CONSULTANT', 'TRAINER', 'QUALITY']
    if (isAccreditation && !validAccTypes.includes(accreditationType)) {
      return NextResponse.json({ error: 'يرجى اختيار نوع الاعتماد' }, { status: 400 })
    }

    if (!orgName?.trim() || !repName?.trim() || !email?.trim() || !country?.trim() || (!isAccreditation && !territory?.trim())) {
      return NextResponse.json(
        { error: 'يرجى إكمال جميع الحقول الإلزامية' },
        { status: 400 }
      )
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(email.trim())) {
      return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    }

    // بوابة الدخول: لا تقديم من زائر — يضغط إرسال فيُطلب منه الدخول أولاً.
    const owner = await getCurrentUser().catch(() => null)
    if (!owner) {
      return NextResponse.json(
        { error: 'نرجو تسجيل الدخول لاستكمال الطلب', code: 'LOGIN_REQUIRED' },
        { status: 401 }
      )
    }
    if (owner.role === 'ADMIN') {
      return NextResponse.json(
        { error: 'حساب الإدارة لا يقدم طلب وكالة أو اعتماد. استخدم حساب جهة/وكيل منفصل، ثم راجعه من لوحة الإدارة.' },
        { status: 403 }
      )
    }
    if (owner.role === 'SUPERVISOR') {
      return NextResponse.json(
        { error: 'حساب المشرف لا يقدم طلب وكالة أو اعتماد. استخدم حساب جهة/وكيل منفصل حتى لا تختلط صلاحيات الإشراف بملف الاعتماد.' },
        { status: 403 }
      )
    }

    // المرفقات الإلزامية من قواعد الوكالة والاعتماد (مشتركة للنوعين):
    // أي وثيقة مفعّلة هناك تصبح إجبارية هنا، وأي نقص يرفض الطلب مع ذكر الناقص.
    const agentRulesRaw = await getSettingJson('AGENT_ADMISSION_RULES', null)
    const { requiredDocs } = resolveAgentRequiredDocuments(agentRulesRaw)
    {
      const uploaded = new Set(files.map((f) => f.docType))
      const missing = requiredDocs.filter((d) => !uploaded.has(d.type))
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `الوثائق الرسمية غير مكتملة — يرجى رفع: ${missing.map((m) => m.label).join('، ')}`, missing: missing.map((m) => m.label) },
          { status: 400 }
        )
      }
      // نوع واحد لكل وثيقة
      const seen = new Set<string>()
      const uniqueFiles = files.filter((f) => !seen.has(f.docType) && seen.add(f.docType))
      files.length = 0
      files.push(...uniqueFiles)
    }

    const application = await db.agentApplication.create({
      data: {
        userId: owner.id,
        kind: isAccreditation ? 'ACCREDITATION' : 'AGENCY',
        accreditationType: isAccreditation ? String(accreditationType) : null,
        orgName: orgName.trim(),
        repName: repName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone?.trim() || '',
        country: country.trim(),
        territory: territory?.trim() || null,
        experience: experience?.trim() || null,
        documents: {
          create: files.map((f) => ({
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
      include: { documents: { select: { id: true, docType: true, fileName: true, size: true } } },
    })

    // فاتورة رسوم التقديم (غير مستردة) — تُنشأ فور التقديم لكلا النوعين،
    // والمبلغ يُقرأ من الإعدادات لا من رقم ثابت: اعتماد من
    // FEE_ACC_APPLICATION، ووكالة من FEE_AGENCY_APPLICATION.
    const fee = isAccreditation ? await getSettingNum('FEE_ACC_APPLICATION') : await getSettingNum('FEE_AGENCY_APPLICATION')
    const payment = await db.payment.create({
      data: {
        agentId: application.id,
        userId: owner.id,
        invoiceNo: await nextInvoiceNo(),
        purpose: isAccreditation ? 'ACCREDITATION_FEE' : 'AGENCY_FEE',
        description: isAccreditation ? 'رسوم تقديم طلب الاعتماد (غير مستردة) وفق دليل الإجراءات' : 'رسوم تقديم طلب الوكالة (غير مستردة)',
        amount: fee,
        payerName: repName.trim(),
        payerEmail: email.trim().toLowerCase(),
        payerCountry: country.trim(),
      },
    })
    const invoice = { invoiceNo: payment.invoiceNo, amount: fee }

    // إيميل الفاتورة برابط الدفع — والشاشة بعد الإرسال تعرض ملخصه نفسه
    // حتى يفهم المتقدم أن رسالة وصلته وما يضيع الرابط.
    const emailSent = await emailAgentInvoice(email.trim().toLowerCase(), {
      name: repName.trim(),
      kind: isAccreditation ? 'ACCREDITATION' : 'AGENCY',
      invoiceNo: invoice.invoiceNo,
      amount: invoice.amount,
      description: payment.description,
    }).catch(() => false)

    await notify(
      owner.id,
      isAccreditation ? 'ACCREDITATION_SUBMITTED' : 'AGENCY_SUBMITTED',
      isAccreditation ? 'تم استلام طلب الاعتماد' : 'تم استلام طلب الوكالة',
      isAccreditation
        ? `طلب اعتماد ${orgName.trim()} قيد الدراسة — بانتظار سداد رسوم التقديم (${invoice.amount}$) — فاتورة ${invoice.invoiceNo}`
        : `طلب وكالة ${orgName.trim()} قيد المراجعة — بانتظار سداد رسوم التقديم (${invoice.amount}$) — فاتورة ${invoice.invoiceNo}`
    )
    await audit(
      { id: owner.id, name: repName.trim(), role: owner.role } as any,
      isAccreditation ? 'ACCREDITATION_SUBMITTED' : 'AGENCY_SUBMITTED',
      'AgentApplication',
      application.id,
      `${isAccreditation ? 'طلب اعتماد' : 'طلب وكالة'} من ${orgName.trim()} (${country.trim()}) — وثائق: ${files.length}/${requiredDocs.length} — فاتورة ${invoice.invoiceNo}`
    )

    return NextResponse.json({
      ok: true,
      id: application.id,
      documents: application.documents?.map((d) => ({ id: d.id, docType: d.docType, fileName: d.fileName })) || [],
      invoice,
      email: { sent: emailSent, to: email.trim().toLowerCase(), invoiceNo: invoice.invoiceNo, amount: invoice.amount },
      message: isAccreditation
        ? `تم استلام طلب الاعتماد مع الوثائق الرسمية كاملة! سدد رسوم التقديم (${invoice.amount}$) — فاتورة ${invoice.invoiceNo} — ليُحوَّل ملفكم لدراسة الإدارة.`
        : `تم استلام طلب الوكالة بنجاح! سدد رسوم التقديم (${invoice.amount}$) — فاتورة ${invoice.invoiceNo} — ليُحوَّل ملفكم لدراسة الإدارة.`,
    })
  } catch (e) {
    console.error('Agent apply error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء إرسال الطلب' }, { status: 500 })
  }
}
