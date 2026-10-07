import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { adminSettingDefs, getSettings, isMaskedSecretValue, isSecretSettingKey, maskSettingsForAdmin, sanitizePublicSettings } from '@/lib/settings'
import { audit } from '@/lib/notify'

function revalidatePublicSettingsSurfaces() {
  const paths = ['/', '/programs', '/apply', '/about', '/contact', '/accreditation', '/sitemap.xml']
  for (const path of paths) {
    try {
      revalidatePath(path)
    } catch (error) {
      console.warn('settings revalidatePath failed:', path, error)
    }
  }
}

// GET /api/settings — الإعدادات العامة (عام: القيم فقط | الإدارة: التفاصيل)
export async function GET() {
  try {
    const values = await getSettings()
    const user = await getCurrentUser()
    const headers = { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    if (user?.role === 'ADMIN') {
      return NextResponse.json({ values: maskSettingsForAdmin(values), defs: adminSettingDefs() }, { headers })
    }
    return NextResponse.json({ values: sanitizePublicSettings(values) }, { headers })
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
      const inputType = def.inputType || 'number'
      let v = typeof val === 'string' ? val : JSON.stringify(val)
      if (inputType !== 'textarea') v = v.trim()
      if (inputType === 'number') {
        if (v === '' || isNaN(parseFloat(v))) continue
        v = String(parseFloat(v))
      }
      if (inputType === 'json') {
        try {
          const parsed = JSON.parse(v)
          v = JSON.stringify(parsed)
        } catch {
          return NextResponse.json({ error: `قيمة ${def.label} يجب أن تكون JSON صالحاً` }, { status: 400 })
        }
      }
      if ((inputType === 'text' || inputType === 'textarea') && v.length > 5000) {
        return NextResponse.json({ error: `قيمة ${def.label} طويلة جداً` }, { status: 400 })
      }
      if (v === '') continue
      const existing = await db.setting.findUnique({ where: { key } })
      if (!existing || existing.value !== v) changed.push(`${def.label}: ${existing?.value || def.value} ← ${v}${def.suffix ? ` ${def.suffix}` : ''}`)
      await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
    }
    await audit(user, 'UPDATE_SETTINGS', 'Setting', null, changed.join(' | ') || 'لا تغييرات')
    revalidatePublicSettingsSurfaces()
    const updated = await getSettings()
    return NextResponse.json({ ok: true, values: updated }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } })
  } catch (e) {
    console.error('settings PUT error:', e)
    return NextResponse.json({ error: 'تعذر حفظ الإعدادات' }, { status: 500 })
  }
}
