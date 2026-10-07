import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { textAiCompleteJson } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function compact(value?: string | null, max = 8000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function audit(actorId: string, action: string, entityId: string, details: string) {
  await db.auditLog.create({
    data: { actorId, actorName: 'إدارة النظام', action, entity: 'AcademyRepresentative', entityId, details: details.slice(0, 3900) },
  }).catch(() => {})
}

function parseJson(raw: string) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('NO_JSON')
  return JSON.parse(match[0])
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const rep = await db.academyRepresentative.findFirst({
    where: { id, deletedAt: null },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  })
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const fileEvidence = rep.files
    .filter((f) => f.extractedText || f.description || f.externalUrl)
    .slice(0, 12)
    .map((f) => `ملف: ${f.title} [${f.kind}]\nوصف: ${compact(f.description, 700)}\nنص مستخرج: ${compact(f.extractedText, 2500)}\nرابط: ${f.externalUrl || f.fileUrl || ''}`)
    .join('\n\n---\n\n')
  const cvExtractedText = compact(rep.files.find((f) => String(f.kind || '').toUpperCase() === 'CV' && f.extractedText)?.extractedText, 12000)

  const system = `أنت محرر سيرة مهنية رسمي للأكاديمية الأمريكية للاستشارات والتدريب.
المطلوب إعادة صياغة ملف ممثل أكاديمي ليظهر داخل منصة رسمية عامة.
القواعد:
- لا تخترع شهادات أو ألقاباً أو مناصب غير موجودة في المدخلات.
- حافظ على اللغة العربية الاحترافية والوقار الأكاديمي.
- اجعل النص مناسباً للعرض العام وليس إعلاناً مبالغاً فيه.
- إذا كان الدليل غير كافٍ، استخدم صياغة عامة حذرة.
- أعد JSON فقط.`

  const prompt = `بيانات الممثل:
الاسم: ${rep.fullName}
اللقب/الصفة: ${rep.displayTitle || ''}
الدرجة: ${rep.degreeTitle || ''}
الرتبة العلمية: ${rep.academicRank || ''}
الدولة: ${rep.country}
المنطقة: ${rep.region}
النطاق: ${rep.territory || ''}
التخصص: ${rep.specialization || ''}
السيرة الخام: ${compact(rep.rawBio, 9000)}
السيرة الحالية: ${compact(rep.professionalBio, 7000)}
الأعمال الحالية: ${compact(rep.worksSummary, 5000)}
الإنجازات الحالية: ${compact(rep.achievements, 5000)}
الملفات والأدلة:
${fileEvidence || 'لا توجد ملفات مستخرجة.'}

أعد JSON بهذا الشكل:
{
  "shortBio": "ملخص عام في 35-55 كلمة",
  "professionalBio": "سيرة ذاتية مهنية كاملة من 3 إلى 5 فقرات قصيرة",
  "worksSummary": "ملخص أعماله وروابط خبرته بشكل منظم",
  "achievements": "إنجازات ومجالات تميز بصياغة موثقة وحذرة",
  "publicContactNote": "جملة رسمية قصيرة توضّح طريقة التواصل أو نطاق التمثيل"
}`

  try {
    const raw = await textAiCompleteJson({
      system,
      history: [{ role: 'user', text: prompt }],
      temperature: 0.25,
      maxOutputTokens: 2200,
    })
    const parsed = parseJson(raw)
    const updated = await db.academyRepresentative.update({
      where: { id },
      data: {
        shortBio: compact(parsed.shortBio, 900) || rep.shortBio,
        rawBio: compact(rep.rawBio, 12000) || cvExtractedText || rep.rawBio,
        professionalBio: compact(parsed.professionalBio, 12000) || rep.professionalBio,
        worksSummary: compact(parsed.worksSummary, 6000) || rep.worksSummary,
        achievements: compact(parsed.achievements, 6000) || rep.achievements,
        publicContactNote: compact(parsed.publicContactNote, 1200) || rep.publicContactNote,
        aiRewriteStatus: 'UPDATED',
        aiRewriteNote: 'تمت إعادة الصياغة من بيانات السيرة والملفات المرفقة.',
        updatedById: user.id,
      },
      include: { files: true },
    })
    await audit(user.id, 'AI_REWRITE_ACADEMY_REPRESENTATIVE', id, `${updated.fullName} — updated`)
    return NextResponse.json({ representative: updated })
  } catch (error: any) {
    await db.academyRepresentative.update({
      where: { id },
      data: { aiRewriteStatus: 'FAILED', aiRewriteNote: String(error?.message || error).slice(0, 500), updatedById: user.id },
    }).catch(() => {})
    return NextResponse.json({ error: 'AI_REWRITE_FAILED', message: 'تعذر إعادة صياغة السيرة آلياً حالياً. بقيت البيانات الخام محفوظة دون تغيير.' }, { status: 500 })
  }
}
