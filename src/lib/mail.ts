type MailInput = {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  replyTo?: string
}

type MailResult = {
  ok: boolean
  skipped?: boolean
  provider?: 'resend'
  id?: string
  error?: string
}

function cleanText(value: unknown, max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function isMailEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM)
}

export function makeBasicEmailHtml(title: string, body: string, link?: string) {
  const safeTitle = escapeHtml(cleanText(title, 300))
  const safeBody = escapeHtml(cleanText(body, 5000)).replace(/\n/g, '<br />')
  const safeLink = link ? escapeHtml(link) : ''
  return `
    <div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;background:#f5f0e1;padding:24px;color:#0f2b46">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:18px;padding:24px;border:1px solid #eadfbf">
        <h1 style="font-size:22px;margin:0 0 12px;font-weight:800;color:#0f2b46">${safeTitle}</h1>
        <p style="font-size:15px;line-height:1.9;margin:0;color:#334155">${safeBody}</p>
        ${safeLink ? `<p style="margin-top:22px"><a href="${safeLink}" style="display:inline-block;background:#0f2b46;color:#f5f0e1;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700">فتح المنصة</a></p>` : ''}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
        <p style="font-size:12px;color:#64748b;margin:0">هذه رسالة آلية من منصة الأكاديمية.</p>
      </div>
    </div>
  `
}

export async function sendMail(input: MailInput): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.MAIL_FROM
  if (!apiKey || !from) {
    console.log('mail skipped: RESEND_API_KEY or MAIL_FROM is not configured')
    return { ok: true, skipped: true }
  }

  const to = Array.isArray(input.to) ? input.to.filter(Boolean) : [input.to].filter(Boolean)
  if (!to.length) return { ok: false, error: 'missing recipient' }

  const text = input.text || cleanText(input.html?.replace(/<[^>]+>/g, ' ') || '', 5000)
  const html = input.html || makeBasicEmailHtml(input.subject, text)

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject: cleanText(input.subject, 300),
        html,
        text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })

    const data = await res.json().catch(() => ({} as any))
    if (!res.ok) {
      const message = data?.message || data?.error || `Resend error ${res.status}`
      console.error('mail send error:', message)
      return { ok: false, provider: 'resend', error: message }
    }
    return { ok: true, provider: 'resend', id: data?.id }
  } catch (e: any) {
    console.error('mail send exception:', e)
    return { ok: false, provider: 'resend', error: e?.message || 'mail send failed' }
  }
}
