import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { nextInvoiceNo, getSettingNum } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'

// POST /api/agent-apply — طلب وكالة/تمثيل دولي أو طلب اعتماد (شركات/مدربين/مستشارين/جودة)
// وفق دليل إجراءات الاعتماد الرسمي — خطوة «إرفاق الوثائق الرسمية» إلزامية لطلبات الاعتماد:
// 1. صورة عن شهادة الترخيص أو مزاولة المهنة (LICENSE)
// 2. صورة عن الهوية الشخصية أو جواز السفر (ID)
// 3. صور شخصية حديثة (المدربين / المستشارين) (PHOTO)
// 4. صورة عن C.V (CV)
// ثم دفع رسوم تقديم طلب الاعتماد (غير مستردة) 100$ عبر فاتورة تُنشأ فور التقديم

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf']
export const AGENT_REQUIRED_DOCS = ['LICENSE', 'ID', 'PHOTO', 'CV']

export async function POST(req: NextRequest) {
  try {
    let fields: Record<string, string> = {}
    const files: { docType: string; fileName: string; mimeType: string; size: number; data: string }[] = []
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
          files.push({ docType, fileName: f.name.slice(0, 180), mimeType: mime, size: f.size, data: buf.toString('base64') })
        }
      }
    } else {
      fields = await req.json()
    }

    const { kind, accreditationType, orgName, repName, email, phone, country, territory, experience } = fields
    const isAccreditation = kind === 'ACCREDITATION'
    const validAccTypes = ['COMPANY', 'CONSULTANT', 'TRAINER', 'QUALITY']
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

    // قاعدة الدليل الرسمي: طلبات الاعتماد لا تُقبل بدون الوثائق الأربع كاملة
    if (isAccreditation) {
      const uploaded = new Set(files.map((f) => f.docType))
      const missing = AGENT_REQUIRED_DOCS.filter((d) => !uploaded.has(d))
      if (missing.length > 0) {
        const AR: Record<string, string> = {
          LICENSE: 'صورة عن شهادة الترخيص أو مزاولة المهنة',
          ID: 'صورة عن الهوية الشخصية أو جواز السفر',
          PHOTO: 'صورة شخصية حديثة (للمدربين / المستشارين)',
          CV: 'صورة عن السيرة الذاتية C.V',
        }
        return NextResponse.json(
          { error: `الوثائق الرسمية غير مكتملة — يرجى رفع: ${missing.map((m) => AR[m]).join('، ')}`, missing },
          { status: 400 }
        )
      }
      // نوع واحد لكل وثيقة
      const seen = new Set<string>()
      const uniqueFiles = files.filter((f) => !seen.has(f.docType) && seen.add(f.docType))
      files.length = 0
      files.push(...uniqueFiles)
    }

    const owner = await getCurrentUser().catch(() => null)
    if (owner && owner.role === 'ADMIN') {
      return NextResponse.json(
        { error: 'حساب الإدارة لا يقدم طلب وكالة أو اعتماد. استخدم حساب جهة/وكيل منفصل أو قدّم الطلب كزائر، ثم راجعه من لوحة الإدارة.' },
        { status: 403 }
      )
    }
    if (owner && owner.role === 'SUPERVISOR') {
      return NextResponse.json(
        { error: 'حساب المشرف لا يقدم طلب وكالة أو اعتماد. استخدم حساب جهة/وكيل منفصل حتى لا تختلط صلاحيات الإشراف بملف الاعتماد.' },
        { status: 403 }
      )
    }

    const application = await db.agentApplication.create({
      data: {
        userId: owner?.id || null,
        kind: isAccreditation ? 'ACCREDITATION' : 'AGENCY',
        accreditationType: isAccreditation ? String(accreditationType) : null,
        orgName: orgName.trim(),
        repName: repName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone?.trim() || "",
        country: country.trim(),
        territory: territory?.trim() || null,
        experience: experience?.trim() || null,
        documents: isAccreditation
          ? {
              create: files.map((f) => ({
                docType: f.docType,
                fileName: f.fileName,
                mimeType: f.mimeType,
                size: f.size,
                data: f.data,
              })),
            }
          : undefined,
      },
      include: { documents: { select: { id: true, docType: true, fileName: true, size: true } } },
    })

    // فاتورة رسوم تقديم طلب الاعتماد (غير مستردة) 100$ — تُنشأ فور تقديم طلبات الاعتماد
    let invoice: { invoiceNo: string; amount: number } | null = null
    if (isAccreditation) {
      const fee = await getSettingNum('FEE_ACC_APPLICATION')
      const payment = await db.payment.create({
        data: {
          agentId: application.id,
          userId: owner?.id || null,
          invoiceNo: await nextInvoiceNo(),
          purpose: 'ACCREDITATION_FEE',
          description: 'رسوم تقديم طلب الاعتماد (غير مستردة) وفق دليل الإجراءات',
          amount: fee,
          payerName: repName.trim(),
          payerEmail: email.trim().toLowerCase(),
          payerCountry: country.trim(),
        },
      })
      invoice = { invoiceNo: payment.invoiceNo, amount: fee }
    }

    if (owner) {
      await notify(
        owner.id,
        isAccreditation ? 'ACCREDITATION_SUBMITTED' : 'AGENCY_SUBMITTED',
        isAccreditation ? 'تم استلام طلب الاعتماد' : 'تم استلام طلب الوكالة',
        isAccreditation
          ? `طلب اعتماد ${orgName.trim()} قيد الدراسة${invoice ? ` — بانتظار سداد رسوم التقديم (${invoice.amount}$)` : ''}`
          : `طلب وكالة ${orgName.trim()} قيد المراجعة — سيتم التواصل عبر البريد`
      )
    }
    await audit(
      { id: owner?.id || 'guest', name: repName.trim(), role: 'GUEST' } as any,
      isAccreditation ? 'ACCREDITATION_SUBMITTED' : 'AGENCY_SUBMITTED',
      'AgentApplication',
      application.id,
      `${isAccreditation ? 'طلب اعتماد' : 'طلب وكالة'} من ${orgName.trim()} (${country.trim()})${isAccreditation ? ` — وثائق: ${files.length}/4` : ''}`
    )

    return NextResponse.json({
      ok: true,
      id: application.id,
      documents: application.documents?.map((d) => ({ id: d.id, docType: d.docType, fileName: d.fileName })) || [],
      invoice,
      message: isAccreditation
        ? `تم استلام طلب الاعتماد مع الوثائق الرسمية كاملة (${files.length}/4)! سدد رسوم التقديم (${invoice?.amount}$) ليُحوَّل ملفكم لدراسة الإدارة وإصدار شهادة الاعتماد.`
        : 'تم استلام طلب الوكالة بنجاح! ستتم مراجعته من إدارة الأكاديمية والرد عليكم عبر البريد الإلكتروني خلال أيام العمل.',
    })
  } catch (e) {
    console.error('Agent apply error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء إرسال الطلب' }, { status: 500 })
  }
}
