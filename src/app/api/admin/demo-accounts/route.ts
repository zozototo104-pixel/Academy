import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { DEMO_ACCOUNTS, ensurePlatformDemoAccounts } from '@/lib/demo-accounts'

// نفس بوابة مسار الطالب التجريبي (demo-thesis): الحسابات التجريبية بكلمات مرور
// معروفة من الكود، فإنشاؤها/إعادة ضبطها في الإنتاج ممنوع ما لم يُفعَّل صراحة.
function demoAccountsEnabled() {
  if (process.env.VERCEL_ENV !== 'production') return true
  return ['1', 'true', 'yes'].includes(String(process.env.ENABLE_DEMO_ACCOUNTS || '').trim().toLowerCase())
}

export async function GET() {
  try {
    await requireAdmin()
    // نفس بوابة الإنتاج في POST بالضبط: كلمات مرور الحسابات التجريبية معروفة
    // من الكود، فحتى قراءة قائمتها ممنوعة في الإنتاج ما لم تُفعَّل صراحة.
    if (!demoAccountsEnabled()) {
      return NextResponse.json({ error: 'الحسابات التجريبية غير مفعلة في بيئة الإنتاج' }, { status: 403 })
    }
    // قائمة السماح صريحة: الاستجابة لا تحمل حقل كلمة المرور بنيويًا، فلا
    // يمكن أن يتسرب حتى لو تغيّر شكل ثابت الحسابات لاحقًا.
    const accounts = Object.fromEntries(
      Object.entries(DEMO_ACCOUNTS).map(([key, account]) => [
        key,
        { email: account.email, role: account.role, note: account.note },
      ])
    )
    return NextResponse.json({ accounts })
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
}

export async function POST() {
  try {
    await requireAdmin()
    if (!demoAccountsEnabled()) {
      return NextResponse.json({ error: 'الحسابات التجريبية غير مفعلة في بيئة الإنتاج' }, { status: 403 })
    }
    const result = await ensurePlatformDemoAccounts({ resetDefense: true })
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    console.error('demo accounts refresh failed:', e)
    const status = e?.message === 'UNAUTHORIZED' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'UNAUTHORIZED' : 'تعذر تجهيز الحسابات التجريبية' }, { status })
  }
}
