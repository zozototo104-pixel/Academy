import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings'
import { audit } from '@/lib/notify'

// GET /api/settings — الإعدادات العامة (عام: القيم فقط | الإدارة: التفاصيل)
export async function GET() {
  try {
    const values = await getSettings()
    const user = await getCurrentUser()
    if (user?.role === 'ADMIN') {
      return NextResponse.json({ values, defs: DEFAULT_SETTINGS })
    }
    return NextResponse.json({ values })
  } catch (e) {
    console.error('settings GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الإعدادات' }, { status: 500 })
  }
}

// PUT /api/settings — تحديث الرسوم والقواعد من لوحة التحكم (بدون كود)
export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const { values } = await req.json()
    if (!values || typeof values !== 'object') {
      return NextResponse.json({ error: 'بيانات غير صحيحة' }, { status: 400 })
    }
    const changed: string[] = []
    for (const [key, val] of Object.entries(values)) {
      const def = DEFAULT_SETTINGS.find((d) => d.key === key)
      if (!def) continue
      const v = String(val).trim()
      if (v === '' || isNaN(parseFloat(v))) continue
      const existing = await db.setting.findUnique({ where: { key } })
      if (!existing || existing.value !== v) changed.push(`${def.label}: ${existing?.value || def.value} ← ${v} ${def.suffix}`)
      await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
    }
    await audit(user, 'UPDATE_SETTINGS', 'Setting', null, changed.join(' | ') || 'لا تغييرات')
    const updated = await getSettings()
    return NextResponse.json({ ok: true, values: updated })
  } catch (e) {
    console.error('settings PUT error:', e)
    return NextResponse.json({ error: 'تعذر حفظ الإعدادات' }, { status: 500 })
  }
}
