import nodemailer from 'nodemailer'
import { db } from '@/lib/db'

// ===== نظام الإشعارات البريدية للمنصة =====
// إعدادات Resend وSMTP تُدار من لوحة الإدارة أو من متغيرات البيئة.
// بدون إعدادات: لا يتوقف أي إجراء — يُسجَّل البريد في EmailLog بحالة SKIPPED

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  fromName: string
  enabled: boolean
}

export interface SendEmailInput {
  to: string
  subject: string
  event: string
  html: string
  text?: string
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.com'

function env(name: string): string {
  try {
    return process.env[name] || ''
  } catch {
    return ''
  }
}

function plainText(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function safe(value: unknown): string {
  return String(value ?? '')
}

function appLink(path: string): string {
  if (!APP_URL) return path
  return APP_URL.replace(/\/$/, '') + path
}

export async function getSmtpConfig(): Promise<SmtpConfig> {
  const rows = await db.setting.findMany({
    where: { key: { in: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_NAME', 'SMTP_ENABLED'] } },
  }).catch(() => [])
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  const host = map.SMTP_HOST || env('SMTP_HOST') || ''
  const port = parseInt(map.SMTP_PORT || env('SMTP_PORT') || '587', 10) || 587
  const user = map.SMTP_USER || env('SMTP_USER') || ''
  const pass = map.SMTP_PASS || env('SMTP_PASS') || ''
  const from = map.SMTP_FROM || env('SMTP_FROM') || user
  const fromName = map.SMTP_NAME || env('SMTP_NAME') || 'الأكاديمية الأمريكية للاستشارات والتدريب'
  const enabledSetting = map.SMTP_ENABLED !== '' ? map.SMTP_ENABLED === '1' : true
  return {
    host,
    port,
    secure: port === 465,
    user,
    pass,
    from,
    fromName,
    enabled: enabledSetting && !!host && !!user && !!pass,
  }
}

async function getResendConfig(): Promise<{ apiKey: string; from: string }> {
  const rows: { key: string; value: string }[] = await db.setting
    .findMany({ where: { key: { in: ['RESEND_API_KEY', 'MAIL_FROM', 'RESEND_FROM'] } } })
    .catch(() => [])
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return {
    apiKey: map.RESEND_API_KEY || env('RESEND_API_KEY') || '',
    from: map.MAIL_FROM || map.RESEND_FROM || env('MAIL_FROM') || env('RESEND_FROM') || '',
  }
}

async function sendWithResend(input: SendEmailInput): Promise<boolean> {
  const { apiKey, from } = await getResendConfig()
  if (!apiKey || !from) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text || plainText(input.html),
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as any))
    throw new Error(data?.message || data?.error || `Resend error ${res.status}`)
  }
  return true
}

// إرسال بريد فعلي مع أرشفة النتيجة في EmailLog. لا يرمي استثناء حتى لا يعطل الإجراءات الأساسية.
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  try {
    const cfg = await getSmtpConfig()
    if (!cfg.enabled) {
      try {
        const sentByResend = await sendWithResend(input)
        if (sentByResend) {
          await db.emailLog.create({
            data: { to: input.to, subject: input.subject, event: input.event, status: 'SENT', error: 'RESEND' },
          }).catch(() => {})
          return true
        }
      } catch (resendError: any) {
        await db.emailLog.create({
          data: { to: input.to, subject: input.subject, event: input.event, status: 'FAILED', error: `Resend: ${String(resendError?.message || resendError).slice(0, 380)}` },
        }).catch(() => {})
        return false
      }
      await db.emailLog.create({
        data: { to: input.to, subject: input.subject, event: input.event, status: 'SKIPPED', error: 'البريد غير مهيأ — أضف SMTP من لوحة الإدارة أو RESEND_API_KEY و MAIL_FROM في Vercel' },
      }).catch(() => {})
      return false
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10000,
    })
    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.from}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text || plainText(input.html),
    })
    await db.emailLog.create({
      data: { to: input.to, subject: input.subject, event: input.event, status: 'SENT' },
    }).catch(() => {})
    return true
  } catch (e: any) {
    try {
      const sentByResend = await sendWithResend(input)
      if (sentByResend) {
        await db.emailLog.create({
          data: { to: input.to, subject: input.subject, event: input.event, status: 'SENT', error: 'SMTP failed; sent by RESEND' },
        }).catch((error) => { console.warn('Failed to log Resend fallback email success.', error) })
        return true
      }
    } catch (error) {
      console.warn('Resend fallback email delivery failed after SMTP failure.', error)
    }
    await db.emailLog.create({
      data: { to: input.to, subject: input.subject, event: input.event, status: 'FAILED', error: String(e?.message || e).slice(0, 400) },
    }).catch((error) => { console.warn('Failed to log email delivery failure.', error) })
    return false
  }
}

// ===== القالب الرسمي الموحد (RTL بهوية الأكاديمية) =====
export function emailTemplate(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const year = new Date().getFullYear()
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="background:#0f2b46;border-radius:16px 16px 0 0;padding:24px;text-align:center;">
          <div style="color:#e0b83a;font-size:22px;font-weight:800;">🎓 الأكاديمية الأمريكية</div>
          <div style="color:#c9a227;font-size:12px;font-weight:600;margin-top:4px;">للاستشارات والتدريب — AACT · EST. 2016</div>
        </td></tr>
        <tr><td style="background:#ffffff;padding:32px 28px;">
          <h1 style="margin:0 0 16px;color:#0f2b46;font-size:20px;font-weight:800;">${escapeHtml(title)}</h1>
          <div style="color:#334155;font-size:14px;line-height:1.9;">${bodyHtml}</div>
          ${cta ? `<div style="text-align:center;margin-top:28px;"><a href="${cta.url}" style="background:#c9a227;color:#0f2b46;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:800;font-size:14px;display:inline-block;">${escapeHtml(cta.label)}</a></div>` : ''}
        </td></tr>
        <tr><td style="background:#f7edd0;padding:16px 24px;text-align:center;color:#5c4d1a;font-size:11px;line-height:1.8;border-radius:0 0 16px 16px;">
          هذه رسالة آلية من منصة الأكاديمية الأمريكية للاستشارات والتدريب — لا ترد عليها مباشرة.<br/>
          بناء القيادات، صقل المهارات · Building Leaders, Refining Skills
        </td></tr>
      </table>
      <div style="color:#94a3b8;font-size:10px;margin-top:12px;">© ${year} American Academy for Consulting and Training</div>
    </td></tr>
  </table>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function infoRows(rows: { label: string; value: string }[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">${rows
    .map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#ffffff'};"><td style="padding:10px 14px;color:#64748b;font-size:12px;font-weight:700;width:38%;">${escapeHtml(r.label)}</td><td style="padding:10px 14px;color:#0f2b46;font-size:13px;font-weight:800;">${escapeHtml(r.value)}</td></tr>`)
    .join('')}</table>`
}

function greeting(name?: string | null): string {
  return `عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>`
}

export async function emailVerifyAccount(to: string, name: string, verifyUrl: string) {
  return sendEmail({
    to,
    event: 'EMAIL_VERIFICATION',
    subject: 'تأكيد بريدك الإلكتروني في منصة الأكاديمية الأمريكية',
    html: emailTemplate(
      'تأكيد البريد الإلكتروني ✉️',
      `<p>${greeting(name)}،</p><p>شكراً لإنشاء حسابك في منصة الأكاديمية الأمريكية. قبل فتح بوابة الطالب، يرجى تأكيد ملكية بريدك الإلكتروني.</p>${infoRows([
        { label: 'البريد', value: to },
        { label: 'صلاحية الرابط', value: '24 ساعة من وقت الإرسال' },
      ])}<p>إذا لم تنشئ هذا الحساب، يمكنك تجاهل هذه الرسالة.</p>`,
      { label: 'تأكيد البريد الإلكتروني', url: verifyUrl }
    ),
  })
}

export async function emailWelcome(to: string, name: string) {
  await sendEmail({
    to,
    event: 'WELCOME',
    subject: 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب',
    html: emailTemplate(
      `أهلاً بك ${escapeHtml(name)} 🎉`,
      `<p>تم إنشاء حسابك بنجاح في منصة الأكاديمية الأمريكية للاستشارات والتدريب.</p>
       <p>من حسابك يمكنك تقديم طلب الالتحاق، متابعة كود التتبع، الدراسة، الامتحانات، والمحادثة مع المشرف الذكي.</p>`,
      { label: 'الدخول إلى المنصة', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailAdminAlert(to: string, title: string, body: string, event = 'ADMIN_ALERT') {
  await sendEmail({
    to,
    event,
    subject: title,
    html: emailTemplate(title, `<p>${escapeHtml(body)}</p>`, { label: 'فتح لوحة الإدارة', url: appLink('/?view=admin') }),
  })
}

export async function emailRepresentativeOnboardingInvitation(to: string, input: {
  name: string
  country: string
  territory?: string | null
  contractNo?: string | null
  onboardingUrl: string
}) {
  await sendEmail({
    to,
    event: 'REPRESENTATIVE_ONBOARDING_INVITATION',
    subject: 'استكمال ملف ممثل الأكاديمية الرسمي',
    html: emailTemplate(
      'استكمال ملف ممثل الأكاديمية 🌐',
      `<p>${greeting(input.name)}،</p><p>تم اعتماد طلب التمثيل/الوكالة، والخطوة التالية هي استكمال ملف ممثل الأكاديمية قبل عرضه للعامة.</p>${infoRows([
        { label: 'الدولة/النطاق', value: input.territory || input.country },
        { label: 'رقم العقد', value: input.contractNo || 'حسب سجل الوكالة في المنصة' },
        { label: 'المطلوب', value: 'رفع الصورة الشخصية، السيرة الذاتية، الكرنيه أو المرفقات الرسمية، وروابط الأعمال إن وجدت' },
      ])}<p>بعد إرسال الملف ستراجعه الإدارة، ولن يظهر الملف للعامة إلا بعد الاعتماد النهائي.</p>`,
      { label: 'استكمال ملف الممثل', url: input.onboardingUrl }
    ),
  })
}

export async function emailAdminRepresentativeProfileSubmitted(to: string, input: {
  name: string
  country: string
  region: string
  email?: string | null
}) {
  await sendEmail({
    to,
    event: 'ADMIN_REPRESENTATIVE_PROFILE_SUBMITTED',
    subject: `ملف ممثل جاهز للمراجعة — ${input.name}`,
    html: emailTemplate(
      'ملف ممثل الأكاديمية جاهز للمراجعة 📌',
      `<p>قام ممثل وكالة/اعتماد بإرسال ملفه للمراجعة بعد رفع البيانات والمرفقات.</p>${infoRows([
        { label: 'الاسم', value: input.name },
        { label: 'الدولة', value: input.country },
        { label: 'المنطقة', value: input.region },
        { label: 'البريد', value: input.email || 'غير محدد' },
        { label: 'الإجراء المطلوب', value: 'مراجعة ملف ممثلي الدول ثم تحويل الحالة إلى ACTIVE عند الاعتماد' },
      ])}`,
      { label: 'فتح لوحة الإدارة', url: appLink('/?view=admin') }
    ),
  })
}

export async function emailRepresentativeProfileApproved(to: string, input: {
  name: string
  profileUrl: string
}) {
  await sendEmail({
    to,
    event: 'REPRESENTATIVE_PROFILE_APPROVED',
    subject: 'تم اعتماد ملف ممثل الأكاديمية ونشره',
    html: emailTemplate(
      'تم نشر ملف ممثل الأكاديمية ✅',
      `<p>${greeting(input.name)}،</p><p>تمت مراجعة ملفك واعتماده للعرض ضمن قسم ممثلي الأكاديمية في الدول.</p>`,
      { label: 'عرض الملف العام', url: input.profileUrl }
    ),
  })
}

export async function emailAdminNewAdmissionRequest(to: string, input: {
  reference: string
  fullName: string
  applicantEmail: string
  phone: string
  country: string
  program: string
  requestType: string
  status: string
  documentsCount: number
  invoiceNo?: string | null
  amount?: number | null
}) {
  const rows = [
    { label: 'كود الطلب', value: input.reference },
    { label: 'نوع الطلب', value: input.requestType },
    { label: 'الاسم', value: input.fullName },
    { label: 'البريد', value: input.applicantEmail },
    { label: 'الهاتف', value: input.phone },
    { label: 'الدولة', value: input.country },
    { label: 'البرنامج / الخدمة', value: input.program },
    { label: 'الحالة الحالية', value: input.status },
    { label: 'عدد المرفقات', value: String(input.documentsCount) },
  ]
  if (input.invoiceNo) rows.push({ label: 'فاتورة رسوم التقديم', value: input.invoiceNo + (input.amount != null ? ` — ${input.amount}$` : '') })
  await sendEmail({
    to,
    event: 'ADMIN_NEW_ADMISSION_REQUEST',
    subject: `طلب تسجيل جديد — ${input.reference}`,
    html: emailTemplate(
      'وصل طلب تسجيل جديد إلى المنصة 📥',
      `<p>تم تقديم طلب جديد ويحتاج متابعة الإدارة من لوحة التحكم.</p>${infoRows(rows)}<p>افتح لوحة الإدارة لمراجعة الطلب والمرفقات واتخاذ الإجراء المناسب.</p>`,
      { label: 'فتح لوحة الإدارة', url: appLink('/?view=admin') }
    ),
  })
}

export async function emailServiceRequestSubmitted(to: string, name: string, reference: string, service: string) {
  await sendEmail({
    to,
    event: 'SERVICE_REQUEST_SUBMITTED',
    subject: `استلمنا طلبك — كود التتبع ${reference}`,
    html: emailTemplate(
      'تم استلام طلب الخدمة بنجاح ✅',
      `<p>${greeting(name)}،</p><p>استلمنا طلب الخدمة/الاعتماد الخاص بك، وسيتم مراجعته من الإدارة لتحديد الخطوة التالية.</p>${infoRows([
        { label: 'كود تتبع الطلب', value: reference },
        { label: 'الخدمة', value: service },
        { label: 'الخطوة التالية', value: 'مراجعة الإدارة ثم إرسال تعليمات المتابعة أو التسعير أو الموعد' },
      ])}`,
      { label: 'تتبع حالة الطلب', url: appLink('/?view=apply') }
    ),
  })
}

export async function emailAdmissionSubmitted(to: string, name: string, reference: string, program: string, fee: number) {
  await sendEmail({
    to,
    event: 'ADMISSION_SUBMITTED',
    subject: `استلمنا طلب التحاقك — كود التتبع ${reference}`,
    html: emailTemplate(
      'تم استلام طلب الالتحاق بنجاح ✅',
      `<p>${greeting(name)}،</p><p>استلمنا طلب التحاقك مع كامل البيانات والمستندات والإقرار.</p>${infoRows([
        { label: 'كود تتبع الطلب', value: reference },
        { label: 'البرنامج', value: program },
        { label: 'الخطوة التالية', value: `سداد رسوم التقديم وحجز المقعد ${fee}$ (غير مستردة)` },
      ])}<p>بعد سداد رسوم التقديم يُحوَّل ملفك تلقائياً إلى الإدارة للدراسة والإقرار.</p>`,
      { label: 'تتبع حالة الطلب', url: appLink('/?view=apply') }
    ),
  })
}

export async function emailPaymentReceipt(to: string, name: string, invoiceNo: string, description: string, amount: number, receiptNo: string) {
  await sendEmail({
    to,
    event: 'PAYMENT_RECEIPT',
    subject: `إيصال سداد ${receiptNo} — ${amount}$`,
    html: emailTemplate(
      'تم استلام دفعتك بنجاح 💳',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'رقم الإيصال', value: receiptNo },
        { label: 'رقم الفاتورة', value: invoiceNo },
        { label: 'البند', value: description },
        { label: 'المبلغ المسدد', value: `${amount}$` },
      ])}<p>يمكنك مراجعة فواتيرك وإيصالاتك من بوابة الطالب.</p>`,
      { label: 'بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailServiceDeliverablePublished(to: string, name: string, reference: string, title: string, typeLabel: string) {
  await sendEmail({
    to,
    event: 'SERVICE_DELIVERABLE_PUBLISHED',
    subject: `تم تجهيز مخرج جديد لطلبك — ${title}`,
    html: emailTemplate(
      'تم تجهيز مخرج جديد لطلبك ✅',
      `<p>${greeting(name)}،</p><p>تم تجهيز مخرج جديد مرتبط بطلبك في منصة الأكاديمية.</p>${infoRows([
        { label: 'كود الطلب', value: reference },
        { label: 'نوع المخرج', value: typeLabel },
        { label: 'العنوان', value: title },
        { label: 'الخطوة التالية', value: 'افتح حسابك ثم انتقل إلى تبويب مخرجاتي/خدماتي لتحميل الملف أو فتح الرابط.' },
      ])}`,
      { label: 'فتح حسابي', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailAdmissionDecision(to: string, name: string, reference: string, program: string, approved: boolean, note?: string) {
  await sendEmail({
    to,
    event: approved ? 'ADMISSION_APPROVED' : 'ADMISSION_REJECTED',
    subject: approved ? `مبروك — تم قبول طلبك (${reference})` : `بخصوص طلب التحاق (${reference})`,
    html: emailTemplate(
      approved ? 'تهانينا — تمت الموافقة على طلبك 🎓' : 'نتيجة دراسة طلب الالتحاق',
      approved
        ? `<p>${greeting(name)}،</p><p>يسرّ إدارة الأكاديمية إعلامك بقبول طلب الالتحاق.</p>${infoRows([{ label: 'البرنامج', value: program }, { label: 'كود التتبع', value: reference }])}${note ? `<p>${escapeHtml(note)}</p>` : ''}<p>صدرت فاتورة الرسوم الدراسية كاملة في حسابك عند انطباقها.</p>`
        : `<p>${greeting(name)}،</p><p>بعد دراسة ملفك لطلب (${escapeHtml(reference)}) — برنامج: ${escapeHtml(program)} — لم تتم الموافقة في هذه الجلسة.</p>${note ? `<p><strong>ملاحظات الإدارة:</strong> ${escapeHtml(note)}</p>` : ''}`,
      { label: 'فتح حسابي', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailFinalRegistration(to: string, name: string, program: string) {
  await sendEmail({
    to,
    event: 'FINAL_REGISTRATION',
    subject: `تسجيلك النهائي في «${program}» فعّال 🎉`,
    html: emailTemplate(
      'تسجيلك النهائي مكتمل — أهلاً بك في برنامجك 🎉',
      `<p>${greeting(name)}،</p><p>أصبح تسجيلك النهائي في <strong>${escapeHtml(program)}</strong> فعالاً، ويمكنك الآن بدء الدراسة من بوابة الطالب.</p>`,
      { label: 'ابدأ الدراسة الآن', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailExamPublished(to: string, name: string, program: string, questionsCount: number, durationMin: number) {
  await sendEmail({
    to,
    event: 'EXAM_PUBLISHED',
    subject: `امتحان الفصل متاح الآن — ${program}`,
    html: emailTemplate(
      'امتحان الفصل الدراسي أصبح متاحاً 📝',
      `<p>${greeting(name)}،</p><p>نشرت الإدارة امتحان الفصل الدراسي.</p>${infoRows([
        { label: 'البرنامج', value: program },
        { label: 'عدد الأسئلة', value: String(questionsCount) },
        { label: 'مدة الامتحان', value: `${durationMin} دقيقة` },
      ])}`,
      { label: 'دخول الامتحان', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailAssignmentPublished(to: string, name: string, program: string, assignmentTitle: string, dueDays?: number | null) {
  await sendEmail({
    to,
    event: 'ASSIGNMENT_PUBLISHED',
    subject: `واجب جديد متاح — ${assignmentTitle}`,
    html: emailTemplate(
      'تم نشر واجب جديد 📌',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'البرنامج', value: program },
        { label: 'عنوان الواجب', value: assignmentTitle },
        { label: 'المهلة', value: dueDays ? `${dueDays} يوم من تاريخ النشر` : 'حسب تعليمات الإدارة داخل المنصة' },
      ])}`,
      { label: 'فتح الواجبات', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailAssignmentGraded(to: string, name: string, assignmentTitle: string, status: string, score?: number | null, points?: number | null, feedback?: string | null) {
  const needsRevision = status === 'NEEDS_REVISION'
  await sendEmail({
    to,
    event: needsRevision ? 'ASSIGNMENT_NEEDS_REVISION' : 'ASSIGNMENT_GRADED',
    subject: needsRevision ? `واجب يحتاج تعديلًا — ${assignmentTitle}` : `تم تصحيح واجبك — ${assignmentTitle}`,
    html: emailTemplate(
      needsRevision ? 'واجبك يحتاج تعديلًا' : 'تم تصحيح واجبك ✅',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'الواجب', value: assignmentTitle },
        { label: 'الحالة', value: needsRevision ? 'يحتاج تعديلًا' : 'تم التصحيح' },
        { label: 'الدرجة', value: score != null ? `${score}${points ? ` / ${points}` : ''}` : 'حسب تفاصيل المنصة' },
      ])}${feedback ? `<p><strong>ملاحظات المصحح:</strong> ${escapeHtml(feedback)}</p>` : ''}`,
      { label: 'فتح بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailDefenseScheduled(to: string, name: string, thesisTitle: string, defenseDate: Date, committee: string[], tzNote: string) {
  const dateAr = new Intl.DateTimeFormat('ar-EG', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(defenseDate)
  await sendEmail({
    to,
    event: 'DEFENSE_SCHEDULED',
    subject: 'موعد مناقشة بحثك عبر الفيديو كونفرنس',
    html: emailTemplate(
      'تم تحديد موعد مناقشة بحثك 🎥',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'عنوان البحث', value: thesisTitle },
        { label: 'الموعد', value: `${dateAr} — ${tzNote}` },
        { label: 'اللجنة', value: committee.join('، ') || 'ستُعلن' },
      ])}`,
      { label: 'فتح قاعة المناقشة', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailThesisPlanDecision(to: string, name: string, thesisTitle: string, approved: boolean) {
  await sendEmail({
    to,
    event: approved ? 'THESIS_PLAN_APPROVED' : 'THESIS_PLAN_NEEDS_REVISION',
    subject: approved ? 'تم اعتماد خطة بحث التخرج' : 'خطة بحث التخرج تحتاج تعديلًا',
    html: emailTemplate(
      approved ? 'تم اعتماد خطة البحث ✅' : 'خطة البحث تحتاج تعديلًا',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'عنوان البحث', value: thesisTitle },
        { label: 'الحالة', value: approved ? 'خطة البحث معتمدة' : 'تحتاج تعديلًا' },
      ])}`,
      { label: 'فتح بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailThesisFinalRevision(to: string, name: string, thesisTitle: string, reviewNote?: string | null) {
  await sendEmail({
    to,
    event: 'THESIS_FINAL_NEEDS_REVISION',
    subject: 'البحث النهائي يحتاج تعديلًا',
    html: emailTemplate(
      'البحث النهائي يحتاج تعديلًا',
      `<p>${greeting(name)}،</p><p>راجعت الإدارة/المشرف البحث النهائي، ويحتاج إلى تعديلات قبل جدولة المناقشة.</p>${infoRows([{ label: 'عنوان البحث', value: thesisTitle }])}${reviewNote ? `<p><strong>ملاحظة الإدارة/المشرف:</strong> ${escapeHtml(reviewNote)}</p>` : ''}`,
      { label: 'فتح بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailThesisResultApproved(to: string, name: string, thesisTitle: string, score: number, passed: boolean) {
  await sendEmail({
    to,
    event: passed ? 'THESIS_RESULT_PASSED' : 'THESIS_RESULT_NOT_PASSED',
    subject: passed ? `تم اعتماد نتيجة مناقشة بحثك — ${score}%` : `نتيجة مناقشة بحثك — ${score}%`,
    html: emailTemplate(
      passed ? 'مبروك — تم اعتماد نتيجة المناقشة 🎓' : 'تم اعتماد نتيجة المناقشة',
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'عنوان البحث', value: thesisTitle },
        { label: 'الدرجة', value: `${score}%` },
        { label: 'النتيجة', value: passed ? 'مجتاز' : 'غير مجتاز / يحتاج مراجعة' },
      ])}`,
      { label: 'فتح بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailThesisTopicDecision(to: string, name: string, title: string, status: string, adminNote?: string) {
  const approved = status === 'APPROVED'
  const rejected = status === 'REJECTED'
  const needsRevision = status === 'NEEDS_REVISION'
  const label = approved ? 'تم اعتماد عنوان بحث التخرج' : needsRevision ? 'عنوان بحث التخرج يحتاج تعديلًا' : rejected ? 'تم رفض عنوان بحث التخرج' : 'تحديث على عنوان بحث التخرج'
  await sendEmail({
    to,
    event: `THESIS_TOPIC_${status}`,
    subject: label,
    html: emailTemplate(
      label,
      `<p>${greeting(name)}،</p>${infoRows([
        { label: 'عنوان البحث', value: title },
        { label: 'الحالة', value: approved ? 'معتمد' : needsRevision ? 'يحتاج تعديل' : rejected ? 'مرفوض' : status },
      ])}${adminNote ? `<p><strong>ملاحظة الإدارة:</strong> ${escapeHtml(adminNote)}</p>` : ''}`,
      { label: 'فتح بوابة الطالب', url: appLink('/?view=dashboard') }
    ),
  })
}

export async function emailCertificateIssued(to: string, name: string, program: string, serial: string) {
  await sendEmail({
    to,
    event: 'CERTIFICATE_ISSUED',
    subject: `شهادتك جاهزة — ${serial} 🏆`,
    html: emailTemplate(
      'تم إصدار شهادتك الرسمية 🏆',
      `<p>تهانينا <strong>${escapeHtml(name)}</strong>!</p><p>صدرت شهادتك الرسمية من الأكاديمية الأمريكية للاستشارات والتدريب:</p>${infoRows([
        { label: 'البرنامج', value: program },
        { label: 'رقم الشهادة', value: serial },
      ])}<p>يمكنك تحميل الشهادة من حسابك والتحقق منها عبر صفحة التحقق الرسمية.</p>`,
      { label: 'التحقق من الشهادة', url: appLink('/?view=verify') }
    ),
  })
}
