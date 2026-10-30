import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { createDefenseGuestInvite, defenseGuestInviteProblem } from '@/lib/defense-invites'

// إدارة دعوات المناقشين الخارجيين لقاعة المناقشة (أدمن فقط).
// الرابط النصي يُعاد مرة واحدة عند الإنشاء — المخزّن هاشه فقط فلا يمكن استرجاعه لاحقاً.

function publicInvite(invite: any) {
  return {
    id: invite.id,
    thesisId: invite.thesisId,
    name: invite.name,
    role: invite.role,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt,
    lastJoinedAt: invite.lastJoinedAt,
    createdAt: invite.createdAt,
    status: defenseGuestInviteProblem(invite) === 'REVOKED' ? 'REVOKED' : defenseGuestInviteProblem(invite) === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const thesisId = req.nextUrl.searchParams.get('thesisId')
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })
    const invites = await db.defenseGuestInvite.findMany({
      where: { thesisId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({ invites: invites.map(publicInvite) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'صلاحيات غير كافية' }, { status: 403 })
    }
    console.error('defense invites GET error:', e)
    return NextResponse.json({ error: 'خطأ في جلب الدعوات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const thesisId = String(body.thesisId || '')
    const name = String(body.name || '').trim().slice(0, 80)
    const role = body.role === 'AGENT' ? 'AGENT' : 'COMMITTEE'
    if (!thesisId || !name) return NextResponse.json({ error: 'اسم المناقش ومعرف البحث مطلوبان' }, { status: 400 })
    const thesis = await db.thesisSubmission.findUnique({
      where: { id: thesisId },
      select: { id: true, title: true, defenseDate: true },
    })
    if (!thesis) return NextResponse.json({ error: 'البحث غير موجود' }, { status: 404 })

    // الانتهاء الافتراضي: يومان بعد موعد المناقشة (أو ٧ أيام من الآن إن لم تُجدول بعد)، بسقف ٣٠ يوماً
    let expiresAt: Date
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt)
      if (Number.isNaN(expiresAt.getTime())) return NextResponse.json({ error: 'تاريخ انتهاء غير صالح' }, { status: 400 })
    } else if (thesis.defenseDate) {
      expiresAt = new Date(new Date(thesis.defenseDate).getTime() + 2 * 24 * 60 * 60 * 1000)
    } else {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }
    if (expiresAt.getTime() <= Date.now()) return NextResponse.json({ error: 'تاريخ الانتهاء يجب أن يكون في المستقبل' }, { status: 400 })
    if (expiresAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      return NextResponse.json({ error: 'تاريخ الانتهاء أبعد من الحد الأقصى (٣٠ يوماً)' }, { status: 400 })
    }

    const { invite, token } = await createDefenseGuestInvite(db as any, {
      thesisId,
      name,
      role,
      expiresAt,
      createdById: admin.id,
    })
    await audit(admin, 'CREATE_DEFENSE_GUEST_INVITE', 'ThesisSubmission', thesisId, `${name} — ${thesis.title}`)
    const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
    return NextResponse.json({
      ok: true,
      invite: publicInvite(invite),
      token,
      url: `${base}/defense/guest/${token}`,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'صلاحيات غير كافية' }, { status: 403 })
    }
    console.error('defense invites POST error:', e)
    return NextResponse.json({ error: 'خطأ في إنشاء الدعوة' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const id = String(body.id || '')
    if (!id) return NextResponse.json({ error: 'معرف الدعوة مطلوب' }, { status: 400 })
    const invite = await db.defenseGuestInvite.findUnique({ where: { id } })
    if (!invite) return NextResponse.json({ error: 'الدعوة غير موجودة' }, { status: 404 })
    if (!invite.revokedAt) {
      await db.defenseGuestInvite.update({ where: { id }, data: { revokedAt: new Date() } })
      // إنهاء أي جلسة ضيف جارية بهذه الدعوة
      await db.defenseParticipant.deleteMany({ where: { guestInviteId: id } }).catch(() => {})
    }
    await audit(admin, 'REVOKE_DEFENSE_GUEST_INVITE', 'ThesisSubmission', invite.thesisId, invite.name)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'صلاحيات غير كافية' }, { status: 403 })
    }
    console.error('defense invites DELETE error:', e)
    return NextResponse.json({ error: 'خطأ في إلغاء الدعوة' }, { status: 500 })
  }
}
