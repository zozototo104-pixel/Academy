import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'
import { getSettings } from '@/lib/settings'
import { emailDefenseScheduled } from '@/lib/mailer'

// GET /api/admin/thesis — كل أبحاث التخرج (لجدولة المناقشات واللجان)
export async function GET() {
  try {
    await requireAdmin()
    const rows = await db.thesisSubmission.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true,
        title: true,
        abstract: true,
        status: true,
        defenseDate: true,
        committee: true,
        agentMember: true,
        defenseStatus: true,
        aiScore: true,
        aiRecommendation: true,
        defenseMinutes: true,
        recordingSize: true,
        recordingDurationSec: true,
        resultScore: true,
        passed: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true, country: true } },
        admission: { select: { id: true, reference: true, program: true, status: true, approvedAt: true, thesisDeadline: true } },
      },
    })
    const theses = rows.map((t) => ({
      ...t,
      abstract: t.abstract?.length > 700 ? `${t.abstract.slice(0, 700)}...` : t.abstract,
      aiRecommendation: t.aiRecommendation?.length && t.aiRecommendation.length > 900 ? `${t.aiRecommendation.slice(0, 900)}...` : t.aiRecommendation,
      defenseMinutes: t.defenseMinutes?.length && t.defenseMinutes.length > 2500 ? `${t.defenseMinutes.slice(0, 2500)}...` : t.defenseMinutes,
      hasRecording: !!t.recordingSize,
      // مهم: لا نعيد recordingData هنا لأنه فيديو Base64 ثقيل جداً ويؤخر فتح تبويب الإدارة.
    }))
    return NextResponse.json({ theses })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin thesis GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الأبحاث' }, { status: 500 })
  }
}

// PATCH /api/admin/thesis — جدولة مناقشة (لجنة + تاريخ) أو اعتماد النتيجة
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id, action, defenseDate, committee, agentMember, resultScore, passed } = await req.json()
    const thesis = await db.thesisSubmission.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, email: true, country: true } } },
    })
    if (!thesis) return NextResponse.json({ error: 'البحث غير موجود' }, { status: 404 })

    // جدولة المناقشة أمام لجنة متخصصة
    if (action === 'SCHEDULE') {
      let committeeList: string[] = []
      try { committeeList = JSON.parse(committee || '[]') } catch {}
      committeeList = committeeList.filter((s: string) => s.trim()).slice(0, 6)
      if (committeeList.length === 0 || !defenseDate) {
        return NextResponse.json({ error: 'تاريخ المناقشة وأعضاء اللجنة مطلوبون' }, { status: 400 })
      }
      const updated = await db.thesisSubmission.update({
        where: { id },
        data: {
          status: 'SCHEDULED',
          defenseDate: new Date(defenseDate),
          committee: JSON.stringify(committeeList),
          agentMember: agentMember?.trim() || null,
        },
      })
      // عضو من الوكيل الدولي في اللجنة → مستحق 100$ وفق العقد
      if (agentMember?.trim()) {
        const agent = await db.agentApplication.findFirst({
          where: { kind: 'AGENCY', status: 'APPROVED' },
        })
        if (agent) {
          const settings = await getSettings()
          const fee = parseFloat(settings.COMMITTEE_MEMBER_FEE || '100')
          const dueDate = new Date()
          dueDate.setDate(dueDate.getDate() + 14)
          await db.revenueShareTransaction.create({
            data: {
              agentId: agent.id,
              type: 'COMMITTEE_FEE',
              description: `مشاركة في لجنة مناقشة بحث «${thesis.title.slice(0, 60)}» — 100$ وفق العقد`,
              amount: fee,
              dueDate,
              programCountry: thesis.user.country || null,
            },
          })
        }
      }
      // تحديث حالة الطلب إلى مجدول للمناقشة
      if (thesis.admissionId) {
        await db.admissionApplication.update({
          where: { id: thesis.admissionId },
          data: { status: 'SCHEDULED' },
        }).catch(() => {})
      }
      await notify(
        thesis.userId,
        'DEFENSE',
        'تم تحديد موعد مناقشتك',
        `بمناسبة بحث «${thesis.title}»: حُدد موعد المناقشة ${new Date(defenseDate).toLocaleDateString('ar-EG')} أمام اللجنة المختصة (${committeeList.length} أعضاء${agentMember ? ' + عضو الوكيل الدولي' : ''}). حظاً موفقاً!`,
        'dashboard'
      )
      await audit(admin, 'SCHEDULE_DEFENSE', 'ThesisSubmission', id, `${thesis.title} — ${defenseDate}`)
      // بريد الموعد مع التوقيت المحلي للطالب ولجنة المناقشة
      {
        const student = await db.user.findUnique({ where: { id: thesis.userId }, select: { email: true, name: true, country: true } })
        if (student?.email) {
          let tzNote = 'حسب توقيت دولتك'
          try {
            tzNote = new Intl.DateTimeFormat('ar-EG', {
              weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
            }).format(new Date(defenseDate)) + ' (بتوقيت UTC — ستظهر موعدك المحلي داخل القاعة)'
          } catch {}
          emailDefenseScheduled(student.email, student.name, thesis.title, new Date(defenseDate), committeeList, tzNote).catch(() => {})
        }
      }
      return NextResponse.json({ ok: true, thesis: updated })
    }

    // اعتماد نتيجة المناقشة
    if (action === 'RESULT') {
      if (resultScore === undefined || passed === undefined) {
        return NextResponse.json({ error: 'الدرجة والنتيجة مطلوبتان' }, { status: 400 })
      }
      const updated = await db.thesisSubmission.update({
        where: { id },
        data: { status: 'RESULT_APPROVED', resultScore, passed, reviewedAt: new Date() },
      })
      if (thesis.admissionId) {
        await db.admissionApplication.update({
          where: { id: thesis.admissionId },
          data: { status: 'RESULT_APPROVED' },
        }).catch(() => {})
      }
      await notify(
        thesis.userId,
        'DEFENSE',
        passed ? 'مبروك — اجتزت مناقشة بحثك!' : 'نتيجة المناقشة',
        passed
          ? `تم اعتماد نتيجة مناقشة بحث «${thesis.title}» بدرجة ${resultScore}. بعد سداد الرسوم الدراسية الكاملة تُصدر شهادتك خلال 30 يوماً كحد أقصى.`
          : `نتيجة مناقشة «${thesis.title}»: لم تُعتمد النتيجة (الدرجة ${resultScore}). يرجى مراجعة مشرفك الأكاديمي لتعديلات البحث.`,
        'dashboard'
      )
      await audit(admin, 'APPROVE_RESULT', 'ThesisSubmission', id, `${thesis.title} — ${resultScore} ${passed ? 'ناجح' : 'غير مجتاز'}`)
      return NextResponse.json({ ok: true, thesis: updated })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin thesis PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التحديث' }, { status: 500 })
  }
}
