import { buildSupervisorPersonaBlock } from '@/lib/ai'
import { db } from '@/lib/db'

export const DEFENSE_AGENT_STRICT_RULES = [
  'أنت مناقش أكاديمي لبحث هذا الطالب فقط؛ لا تخرج إلى كتالوج البرامج العام أو ذاكرة المشرف اليومية.',
  'التزم بعنوان البحث وملخصه وملف الهضم والمقاطع المرتبطة به وبيانات البرنامج الأساسية فقط.',
  'لا تكشف للطالب المعايير الداخلية ولا الأوزان ولا العلامة ولا طريقة الحساب.',
  'لا تعطِ إجابات جاهزة يمكن للطالب قراءتها أمام اللجنة؛ اسأل ووجّه واطلب تبريراً أو توضيحاً.',
  'لا تعلن نتيجة نهائية ولا نجاحاً ولا رسوباً؛ القرار النهائي للجنة البشرية والإدارة.',
  'إذا سأل الطالب خارج بحثه فاعتذر باختصار وأعد النقاش إلى المنهجية أو النتائج أو الأدبيات أو الإسهام أو العرض.',
].join('\n- ')

function compact(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function digestText(value: unknown) {
  if (!value) return ''
  try {
    return JSON.stringify(value, null, 2).slice(0, 6000)
  } catch {
    return compact(value, 6000)
  }
}

export function buildDefenseOnlyContextForTest(input: { thesisTitle: string; digest?: unknown; chunks?: Array<{ index?: number; summary?: string | null; text?: string | null; pageStart?: number | null; pageEnd?: number | null }>; programTitle?: string | null }) {
  const chunks = (input.chunks || []).slice(0, 6).map((chunk, i) => {
    const page = chunk.pageStart ? ` — ص ${chunk.pageStart}${chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ''}` : ''
    return `مقطع ${chunk.index ?? i + 1}${page}: ${compact(chunk.summary || chunk.text, 900)}`
  }).filter(Boolean).join('\n')
  return [
    '<<<THESIS_DEFENSE_CONTEXT>>>',
    `تعليمات المناقش الصارمة:\n- ${DEFENSE_AGENT_STRICT_RULES}`,
    `عنوان البحث: ${compact(input.thesisTitle, 400)}`,
    input.programTitle ? `البرنامج: ${compact(input.programTitle, 240)}` : '',
    input.digest ? `هضم البحث JSON:\n${digestText(input.digest)}` : '',
    chunks ? `مقاطع من البحث:\n${chunks}` : '',
    '<<<END_THESIS_DEFENSE_CONTEXT>>>',
  ].filter(Boolean).join('\n\n')
}

export async function findScheduledStudentDefense(userId: string, thesisId?: string | null) {
  const where: any = { userId, status: 'SCHEDULED' }
  if (thesisId) where.id = thesisId
  return db.thesisSubmission.findFirst({
    where,
    orderBy: { defenseDate: 'asc' },
    include: {
      admission: { select: { program: true, programRef: { select: { titleAr: true, titleEn: true, category: true } } } },
      chunks: { where: { status: { not: 'FAILED' } }, orderBy: { index: 'asc' }, take: 6, select: { index: true, summary: true, text: true, pageStart: true, pageEnd: true } },
    },
  })
}

export async function buildDefenseOnlyContextForStudent(userId: string, thesisId?: string | null) {
  const thesis = await findScheduledStudentDefense(userId, thesisId)
  if (!thesis) return null
  const programTitle = thesis.admission?.programRef?.titleAr || thesis.admission?.program || null
  return {
    thesisId: thesis.id,
    context: buildDefenseOnlyContextForTest({
      thesisTitle: thesis.title,
      digest: thesis.digest,
      chunks: thesis.chunks,
      programTitle,
    }),
  }
}

export function buildDefenseLiveSystemInstruction(defenseContext: string) {
  return [
    buildSupervisorPersonaBlock('DEFENSE'),
    'هذه جلسة صوتية لمناقشة بحث تخرج. التزم بدور المناقش فقط.',
    defenseContext,
  ].join('\n\n')
}
