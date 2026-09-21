import nodemailer from 'nodemailer'
import { db } from '@/lib/db'

// ===== نظام الإشعارات البريدية للمنصة =====
// إعدادات SMTP تُدار من لوحة الإدارة (تبويب «البريد والدفع») أو من متغيرات البيئة
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

function env(name: string): string {
  try {
    return process.env[name] || ''
  } catch {
    return ''
  }
}

export async function getSmtpConfig(): Promise<SmtpConfig> {
  const rows = await db.setting.findMany({
    where: { key: { in: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_NAME', 'SMTP_ENABLED'] } },
  })
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

export interface SendEmailInput {
  to: string
  subject: string
  event: string
  html: string
  text?: string
}

async function getResendConfig(): Promise<{ apiKey: string; from: string }> {
  const rows = await db.setting.findMany({ where: { key: { in: ['RESEND_API_KEY', 'MAIL_FROM', 'RESEND_FROM'] } } }).catch(() => [])
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
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text || input.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as any))
    throw new Error(data?.message || data?.error || `Resend error ${res.status}`)
  }
  return true
}

// إرسال بريد فعلي مع أرشفة النتيجة في EmailLog (لا يرمي استثناء أبداً حتى لا يعطل الإجراءات)
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
      text: input.text || input.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
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
        }).catch(() => {})
        return true
      }
    } catch {}
    await db.emailLog.create({
      data: { to: input.to, subject: input.subject, event: input.event, status: 'FAILED', error: String(e?.message || e).slice(0, 400) },
    }).catch(() => {})
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
    .map(
      (r, i) =>
        `<tr style="background:${i % 2 ? '#f8fafc' : '#ffffff'};"><td style="padding:10px 14px;color:#64748b;font-size:12px;font-weight:700;width:38%;">${escapeHtml(r.label)}</td><td style="padding:10px 14px;color:#0f2b46;font-size:13px;font-weight:800;">${escapeHtml(r.value)}</td></tr>`
    )
    .join('')}</table>`
}

// ===== دوال الأحداث الرئيسية =====

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || ''

export async function emailWelcome(to: string, name: string) {
  await sendEmail({
    to,
    event: 'WELCOME',
    subject: 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب',
    html: emailTemplate(
      `أهلاً بك ${escapeHtml(name)} 🎉`,
      `<p>تم إنشاء حسابك بنجاح في منصة الأكاديمية الأمريكية للاستشارات والتدريب.</p>
       <p>من حسابك يمكنك: تقديم طلب الالتحاق بالبرامج ومتابعته بكود التتبع، الدردشة مع <strong>المشرف الذكي</strong> صوتياً ونصياً،
       دراسة الوحدات والكتب المقررة، دخول الامتحانات الذكية، وحضور مناقشة بحثك عبر <strong>الفيديو كونفرنس</strong> داخل المنصة.</p>`,
      { label: 'الدخول إلى المنصة', url: APP_URL || 'https://aact.academy' }
    ),
  })
}

export async function emailAdminAlert(to: string, title: string, body: string, event = 'ADMIN_ALERT') {
  await sendEmail({
    to,
    event,
    subject: title,
    html: emailTemplate(
      title,
      `<p>${escapeHtml(body)}</p>`,
      { label: 'فتح لوحة الإدارة', url: `${APP_URL}/?view=admin` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       <p>استلمنا طلب الخدمة/الاعتماد الخاص بك، وسيتم مراجعته من الإدارة لتحديد الخطوة التالية.</p>
       ${infoRows([
         { label: 'كود تتبع الطلب', value: reference },
         { label: 'الخدمة', value: service },
         { label: 'الخطوة التالية', value: 'مراجعة الإدارة ثم إرسال تعليمات المتابعة أو التسعير أو الموعد' },
       ])}`,
      { label: 'تتبع حالة الطلب', url: `${APP_URL}/?view=apply` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       <p>استلمنا طلب التحاقك مع كامل البيانات والمستندات والإقرار. للاستعلام عن حالة طلبك في أي وقت استخدم كود التتبع التالي:</p>
       ${infoRows([
         { label: 'كود تتبع الطلب', value: reference },
         { label: 'البرنامج', value: program },
         { label: 'الخطوة التالية', value: `سداد رسوم التقديم وحجز المقعد ${fee}$ (غير مستردة)` },
       ])}
       <p>بعد سداد رسوم التقديم يُحوَّل ملفك تلقائياً إلى الإدارة للدراسة والإقرار، وعند الموافقة تصلك فاتورة الرسوم الدراسية كاملة للدخول للبرنامج.</p>`,
      { label: 'تتبع حالة الطلب', url: `${APP_URL}/?view=apply` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       ${infoRows([
         { label: 'رقم الإيصال', value: receiptNo },
         { label: 'رقم الفاتورة', value: invoiceNo },
         { label: 'البند', value: description },
         { label: 'المبلغ المسدد', value: `${amount}$` },
       ])}
       <p>يمكنك دائماً مراجعة فواتيرك وإيصالاتك من بوابة الطالب داخل المنصة.</p>`,
      { label: 'بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
        ? `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
           <p>يسرّ إدارة الأكاديمية الأمريكية إعلامك بـ<strong>قبول</strong> طلب التحاق في برنامج:</p>
           ${infoRows([{ label: 'البرنامج', value: program }, { label: 'كود التتبع', value: reference }])}
           <p>${escapeHtml(note || '')}</p>
           <p>صدرت فاتورة الرسوم الدراسية كاملة في حسابك — بعد سدادها يُفعَّل تسجيلك النهائي وتصبح بوابة البرنامج والكتب والمشرف الذكي متاحة لك فوراً.</p>`
        : `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
           <p>نشكرك لثقتك بالأكاديمية. بعد دراسة ملفك لطلب (${reference}) — برنامج: ${escapeHtml(program)} — لم يتمكن فريق القبول من الموافقة في هذه الجلسة.</p>
           ${note ? `<p><strong>ملاحظات الإدارة:</strong> ${escapeHtml(note)}</p>` : ''}
           <p>يمكنك التواصل معنا لمعرفة الخيارات المتاحة أو إعادة التقديم مستقبلاً.</p>`
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       <p>بعد سداد الرسوم الدراسية كاملة، أصبح تسجيلك النهائي في <strong>${escapeHtml(program)}</strong> فعالاً.</p>
       <p>يمكنك الآن: دراسة وحدات البرنامج، قراءة <strong>الكتب المقررة</strong>، دخول <strong>امتحانات الفصلين الذكية</strong>،
       وإكمال بحث التخرج ومناقشته عبر قاعة <strong>الفيديو كونفرنس</strong> — ويرافقك <strong>المشرف الذكي</strong> في كل خطوة.</p>`,
      { label: 'ابدأ الدراسة الآن', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       <p>نشرت الإدارة امتحان الفصل الدراسي لبرنامج <strong>${escapeHtml(program)}</strong> بعد اعتماد أسئلته:</p>
       ${infoRows([
         { label: 'عدد الأسئلة', value: `${questionsCount} سؤالاً متنوعاً (موضوعية + تحليلية + حالات عملية)` },
         { label: 'مدة الامتحان', value: `${durationMin} دقيقة (مؤقت تنازلي)` },
       ])}
       <p>يُفضّل مراجعة الكتب المقررة قبل الدخول — وتُصحَّح إجاباتك التحليلية بالذكاء الاصطناعي فور التسليم مع تقرير نقاط قوتك وضعفك، وللك حق الاعتراض على أي تقييم.</p>`,
      { label: 'دخول الامتحان', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>تم نشر واجب جديد ضمن برنامجك:</p>
       ${infoRows([
         { label: 'البرنامج', value: program },
         { label: 'الواجب', value: assignmentTitle },
         { label: 'المهلة', value: dueDays ? `${dueDays} يوم من تاريخ النشر` : 'حسب تعليمات الإدارة داخل المنصة' },
       ])}
       <p>يرجى فتح بوابة الطالب وقراءة تعليمات الواجب وتسليمه قبل انتهاء المهلة.</p>`,
      { label: 'فتح الواجبات', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>يوجد تحديث على واجبك:</p>
       ${infoRows([
         { label: 'الواجب', value: assignmentTitle },
         { label: 'الحالة', value: needsRevision ? 'يحتاج تعديل' : 'تم التصحيح' },
         { label: 'الدرجة', value: score == null || points == null ? 'لم تُحدد درجة' : `${score}/${points}` },
       ])}
       ${feedback ? `<p><strong>ملاحظات المصحح:</strong> ${escapeHtml(feedback)}</p>` : ''}
       <p>يرجى فتح بوابة الطالب للاطلاع على التفاصيل.</p>`,
      { label: 'فتح بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
      'تم جدولة مناقشة بحث التخرج 🎬',
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name)}</strong>،</p>
       <p>جدولت الإدارة مناقشة بحثك عبر قاعة الفيديو كونفرنس داخل المنصة بحضور لجنة المناقشة والمستشار الذكي (ذكاء اصطناعي استشاري — القرار للجنة البشرية):</p>
       ${infoRows([
         { label: 'عنوان البحث', value: thesisTitle },
         { label: 'الموعد (بتوقيت UTC)', value: dateAr },
         { label: 'توقيتك المحلي', value: tzNote },
         { label: 'اللجنة', value: committee.join('، ') || 'ستُعلن' },
       ])}
       <p>ادخل القاعة قبل الموعد بعشر دقائق، واختبر الكاميرا والمايكروفون من شاشة التجهيز — وسيُسجَّل تفريغ الجلسة ومحضرها وتسجيلها المرئي في ملفك أرشيفاً.</p>`,
      { label: 'فتح قاعة المناقشة', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>${approved ? 'تم اعتماد خطة بحث التخرج الخاصة بك، ويمكنك الآن متابعة إعداد البحث النهائي وتسليمه من بوابة الطالب.' : 'راجعت الإدارة خطة بحث التخرج وتحتاج الخطة إلى تعديل قبل اعتمادها.'}</p>
       ${infoRows([
         { label: 'عنوان البحث', value: thesisTitle },
         { label: 'الحالة', value: approved ? 'خطة البحث معتمدة' : 'تحتاج تعديلًا' },
       ])}
       <p>${approved ? 'افتح بوابة الطالب للاطلاع على مرحلة تسليم البحث النهائي.' : 'افتح بوابة الطالب وعدّل الخطة ثم أعد إرسالها للمراجعة.'}</p>`,
      { label: 'فتح بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>راجعت الإدارة/المشرف البحث النهائي، ويحتاج إلى تعديلات قبل جدولة المناقشة.</p>
       ${infoRows([
         { label: 'عنوان البحث', value: thesisTitle },
         { label: 'الحالة', value: 'يحتاج تعديلًا قبل المناقشة' },
       ])}
       ${reviewNote ? `<p><strong>ملاحظة الإدارة/المشرف:</strong> ${escapeHtml(reviewNote)}</p>` : ''}
       <p>افتح بوابة الطالب وعدّل البحث النهائي ثم أعد إرساله للمراجعة.</p>`,
      { label: 'فتح بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>تم اعتماد نتيجة مناقشة بحث التخرج الخاص بك:</p>
       ${infoRows([
         { label: 'عنوان البحث', value: thesisTitle },
         { label: 'الدرجة', value: `${score}%` },
         { label: 'النتيجة', value: passed ? 'مجتاز' : 'غير مجتاز / يحتاج مراجعة' },
       ])}
       ${passed ? '<p>ستتابع الإدارة إجراءات الشهادة وفق سياسة البرنامج وبعد استكمال أي متطلبات مالية أو إدارية متبقية.</p>' : '<p>يرجى مراجعة ملاحظات الإدارة/المشرف داخل المنصة والعمل على التعديلات المطلوبة.</p>'}`,
      { label: 'فتح بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
      `<p>عزيزي/عزيزتي <strong>${escapeHtml(name || 'الطالب')}</strong>،</p>
       <p>يوجد تحديث على طلب عنوان بحث التخرج الخاص بك:</p>
       ${infoRows([
         { label: 'عنوان البحث', value: title },
         { label: 'الحالة', value: approved ? 'معتمد' : needsRevision ? 'يحتاج تعديل' : rejected ? 'مرفوض' : status },
       ])}
       ${adminNote ? `<p><strong>ملاحظة الإدارة:</strong> ${escapeHtml(adminNote)}</p>` : ''}
       ${approved ? '<p>يمكنك الآن متابعة خطة البحث وتسليم البحث وفق تعليمات البرنامج داخل بوابة الطالب.</p>' : '<p>يرجى فتح بوابة الطالب وقراءة الملاحظة ثم تعديل/إرسال العنوان عند الحاجة.</p>'}`,
      { label: 'فتح بوابة الطالب', url: `${APP_URL}/?view=dashboard` }
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
      `<p>تهانينا <strong>${escapeHtml(name)}</strong>!</p>
       <p>صدرت شهادتك الرسمية من الأكاديمية الأمريكية للاستشارات والتدريب:</p>
       ${infoRows([
         { label: 'البرنامج', value: program },
         { label: 'رقم الشهادة', value: serial },
       ])}
       <p>يمكنك تحميل شهادة من حسابك في المنصة، وأي جهة تتحقق من صحتها عبر صفحة التحقق الرسمية بإدخال الرقم أو مسح رمز QR المطبوع عليها.</p>`,
      { label: 'التحقق من الشهادة', url: `${APP_URL}/?view=verify` }
    ),
  })
}
