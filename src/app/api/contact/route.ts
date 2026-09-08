import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// POST /api/contact — نموذج التواصل/الاستفسار العام
export async function POST(req: NextRequest) {
  try {
    const { name, email, phone, subject, message } = await req.json()
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return NextResponse.json({ error: 'الاسم والبريد والرسالة مطلوبة' }, { status: 400 })
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(email.trim())) {
      return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    }
    await db.contactMessage.create({
      data: {
        name: name.trim().slice(0, 120),
        email: email.trim().slice(0, 160),
        phone: phone?.trim().slice(0, 40) || null,
        subject: subject?.trim().slice(0, 200) || 'استفسار عام',
        message: message.trim().slice(0, 3000),
      },
    })
    return NextResponse.json({
      ok: true,
      message: 'تم استلام رسالتك — سيتواصل فريق الأكاديمية معك خلال أيام العمل',
    })
  } catch (e) {
    console.error('contact POST error:', e)
    return NextResponse.json({ error: 'تعذر إرسال الرسالة' }, { status: 500 })
  }
}
