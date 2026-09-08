import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { nextCertSerial } from '@/lib/settings'
import { audit, notify } from '@/lib/notify'
import { randomBytes } from 'crypto'

// GET /api/admin/certificates — كل الشهادات الصادرة
export async function GET() {
  try {
    await requireAdmin()
    const certificates = await db.certificate.findMany({
      orderBy: { issuedAt: 'desc' },
      take: 200,
    })
    return NextResponse.json({ certificates })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الشهادات' }, { status: 500 })
  }
}

// POST /api/admin/certificates — إصدار شهادة يدوياً (لطلبات التحاق أو أي صاحب اسم)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { admissionId, holderName, program, grade, country, userId } = await req.json()
    if (!holderName?.trim() || !program?.trim()) {
      return NextResponse.json({ error: 'اسم صاحب الشهادة والبرنامج مطلوبان' }, { status: 400 })
    }
    const serial = await nextCertSerial()
    const cert = await db.certificate.create({
      data: {
        serial,
        qrToken: randomBytes(16).toString('hex'),
        type: 'PROGRAM_COMPLETION',
        holderName: holderName.trim(),
        program: program.trim(),
        grade: grade?.trim() || null,
        country: country?.trim() || null,
        userId: userId || null,
        admissionId: admissionId || null,
      },
    })
    if (admissionId) {
      const app = await db.admissionApplication.findUnique({ where: { id: admissionId } })
      if (app) {
        await db.admissionApplication.update({ where: { id: admissionId }, data: { status: 'CERTIFIED' } })
        if (app.userId) {
          await notify(app.userId, 'CERTIFICATE', 'تم إصدار شهادتك', `أُصدرت شهادتك لبرنامج «${cert.program}» برقم ${serial} — متاحة في بوابة الطالب.`, 'dashboard')
        }
      }
    }
    await audit(admin, 'ISSUE_CERTIFICATE', 'Certificate', cert.id, `${serial} — ${cert.holderName} (${cert.program})`)
    return NextResponse.json({ ok: true, certificate: cert })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates POST error:', e)
    return NextResponse.json({ error: 'تعذر إصدار الشهادة' }, { status: 500 })
  }
}
