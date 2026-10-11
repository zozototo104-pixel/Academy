import { buildSupervisorPersonaBlock } from '@/lib/ai'
import { db } from '@/lib/db'
import { buildThesisDefenseContextFromParts } from '@/lib/thesis-context'

export const DEFENSE_AGENT_STRICT_RULES = [
  'أنت مناقش أكاديمي لبحث هذا الطالب فقط؛ لا تخرج إلى قوائم البرامج العامة أو ذاكرة المشرف اليومية.',
  'التزم بعنوان البحث وملخصه وملف الهضم والمقاطع المرتبطة به وبيانات البرنامج الأساسية فقط.',
  'لا تكشف للطالب المعايير الداخلية ولا الأوزان ولا العلامة ولا طريقة الحساب.',
  'لا تعطِ إجابات جاهزة يمكن للطالب قراءتها أمام اللجنة؛ اسأل ووجّه واطلب تبريراً أو توضيحاً.',
  'لا تعلن نتيجة نهائية ولا نجاحاً ولا رسوباً؛ القرار النهائي للجنة البشرية والإدارة.',
  'إذا سأل الطالب خارج بحثه فاعتذر باختصار وأعد النقاش إلى المنهجية أو النتائج أو الأدبيات أو الإسهام أو العرض.',
].join('\n- ')

function compact(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function defenseSessionAllowedForTest(thesis: { id?: string | null; status?: string | null; defenseDate?: Date | string | null; extractionStatus?: string | null; digest?: unknown; chunks?: unknown[] | null } | null | undefined) {
  const hasProcessedContent = thesis?.extractionStatus === 'READY' && (Boolean(thesis.digest) || Boolean(thesis.chunks?.length))
  return Boolean(thesis?.id && thesis.status === 'SCHEDULED' && thesis.defenseDate && hasProcessedContent)
}

export function buildDefenseOnlyContextForTest(input: { thesisTitle: string; digest?: unknown; chunks?: Array<{ index?: number; summary?: string | null; text?: string | null; pageStart?: number | null; pageEnd?: number | null }>; programTitle?: string | null }) {
  const wholeContext = buildThesisDefenseContextFromParts({
    thesisTitle: input.thesisTitle,
    digest: input.digest,
    chunks: (input.chunks || []).map((chunk, i) => ({
      index: Number.isFinite(Number(chunk.index)) ? Number(chunk.index) : i + 1,
      summary: chunk.summary || null,
      text: String(chunk.text || chunk.summary || ''),
      pageStart: chunk.pageStart ?? null,
      pageEnd: chunk.pageEnd ?? null,
    })),
    programTitle: input.programTitle,
    maxChars: 14000,
  })
  return [
    '<<<THESIS_DEFENSE_CONTEXT>>>',
    `تعليمات المناقش الصارمة:\n- ${DEFENSE_AGENT_STRICT_RULES}`,
    wholeContext,
    '<<<END_THESIS_DEFENSE_CONTEXT>>>',
  ].join('\n\n')
}

export async function findScheduledStudentDefense(userId: string, thesisId?: string | null) {
  const where: any = { userId, status: 'SCHEDULED' }
  if (thesisId) where.id = thesisId
  return db.thesisSubmission.findFirst({
    where,
    orderBy: { defenseDate: 'asc' },
    include: {
      admission: { select: { program: true, programRef: { select: { titleAr: true, titleEn: true, category: true } } } },
      chunks: { where: { status: { not: 'FAILED' } }, orderBy: { index: 'asc' }, select: { index: true, summary: true, text: true, pageStart: true, pageEnd: true } },
    },
  })
}

export async function buildDefenseOnlyContextForStudent(userId: string, thesisId?: string | null) {
  const thesis = await findScheduledStudentDefense(userId, thesisId)
  if (!thesis || !defenseSessionAllowedForTest(thesis)) return null
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
    'تصرف مثل مناقش بشري قرأ البحث كاملًا: استخدم خريطة البحث وملخصات كل المقاطع لاستخراج أسئلة دقيقة، ولا تخرج عن بحث الطالب.',
    defenseContext,
  ].join('\n\n')
}
