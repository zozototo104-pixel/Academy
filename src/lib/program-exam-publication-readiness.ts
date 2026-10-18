const REQUIRED_PUBLISHED_QUESTIONS = 80
const DEFAULT_MIN_TYPE_DISTRIBUTION: Record<string, number> = { MCQ: 20, TF: 12, SHORT: 10, ESSAY: 8 }
const VALID_SKILLS = new Set(['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE'])
const VALID_DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

function parseJsonArray(value: string | null | undefined): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function hasQuestionBankMarker(value: string | null | undefined): boolean {
  return parseJsonArray(value).some((flag) => String(flag).startsWith('QUESTION_BANK_ITEM_ID:'))
}

export function calculateProgramExamAcademicMissingCounts(questions: any[]) {
  const candidates = questions.filter((q) => q.status !== 'REJECTED')
  const missingSource = candidates.filter((q) =>
    !String(q.sourceEvidence || '').trim() ||
    !String(q.sourceBookTitle || '').trim() ||
    !String(q.sourceLocator || '').trim()
  ).length
  const missingSkill = candidates.filter((q) =>
    !VALID_SKILLS.has(String(q.cognitiveSkill || '')) ||
    !VALID_DIFFICULTIES.has(String(q.difficulty || '')) ||
    !String(q.correctRationale || '').trim()
  ).length
  const missingDistractors = candidates.filter((q) =>
    (q.type === 'MCQ' || q.type === 'TF') && parseJsonArray(q.distractorRationales).length === 0
  ).length
  const remaining = candidates.filter((q) =>
    !String(q.sourceEvidence || '').trim() ||
    !String(q.sourceBookTitle || '').trim() ||
    !String(q.sourceLocator || '').trim() ||
    !VALID_SKILLS.has(String(q.cognitiveSkill || '')) ||
    !VALID_DIFFICULTIES.has(String(q.difficulty || '')) ||
    !String(q.correctRationale || '').trim() ||
    ((q.type === 'MCQ' || q.type === 'TF') && parseJsonArray(q.distractorRationales).length === 0)
  ).length
  const unsourceable = candidates.filter((q) => !hasQuestionBankMarker(q.qualityFlags) && !String(q.knowledgeItemId || '').trim()).length
  return { remaining, missingSource, missingSkill, missingDistractors, unsourceable }
}

function normalizeQuestionText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function minTypeDistributionForDegree(category?: string | null): Record<string, number> {
  if (category === 'DOCTORATE') return { MCQ: 16, TF: 8, SHORT: 18, ESSAY: 22 }
  if (category === 'DIPLOMA') return { MCQ: 30, TF: 18, SHORT: 16, ESSAY: 6 }
  if (category === 'ACCREDITATION' || category === 'INTL_CERT') return { MCQ: 30, TF: 16, SHORT: 16, ESSAY: 5 }
  return DEFAULT_MIN_TYPE_DISTRIBUTION
}

export function validateProgramExamPublicationReadiness(questions: any[], category?: string | null, generatedBy?: string | null): string[] {
  const errors: string[] = []
  const candidates = questions.filter((q) => q.status !== 'REJECTED')
  const isQuestionBankExam = generatedBy === 'QUESTION_BANK'
  const requiredQuestions = isQuestionBankExam ? 5 : REQUIRED_PUBLISHED_QUESTIONS
  if (candidates.length < requiredQuestions) {
    errors.push(`عدد الأسئلة القابلة للنشر (${candidates.length}) أقل من المطلوب (${requiredQuestions}).`)
  }

  if (!isQuestionBankExam) {
    for (const [type, min] of Object.entries(minTypeDistributionForDegree(category))) {
      const count = candidates.filter((q) => q.type === type).length
      if (count < min) errors.push(`تنوع الأسئلة غير كافٍ لهذه الدرجة: نوع ${type} عدده ${count} والمطلوب على الأقل ${min}.`)
    }
  }

  const seen = new Map<string, number>()
  for (const q of candidates) {
    const key = normalizeQuestionText(q.text).slice(0, 180)
    if (!key) continue
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  const duplicateCount = Array.from(seen.values()).filter((n) => n > 1).length
  if (duplicateCount > 0) errors.push(`يوجد ${duplicateCount} سؤالاً أو أكثر بتكرار نصي محتمل؛ راجع التكرار قبل النشر.`)

  const missingSource = candidates.filter((q) =>
    !String(q.sourceEvidence || '').trim() ||
    !String(q.sourceBookTitle || '').trim() ||
    !String(q.sourceLocator || '').trim()
  ).length
  if (missingSource > 0) errors.push(`${missingSource} سؤالاً بلا مصدر أكاديمي مكتمل: اسم كتاب + دليل + موضع/مقطع.`)

  const missingMeasurement = candidates.filter((q) =>
    !VALID_SKILLS.has(String(q.cognitiveSkill || '')) ||
    !VALID_DIFFICULTIES.has(String(q.difficulty || '')) ||
    !String(q.correctRationale || '').trim()
  ).length
  if (missingMeasurement > 0) errors.push(`${missingMeasurement} سؤالاً بلا مهارة/صعوبة/تعليل إجابة مكتمل.`)

  const missingDistractors = candidates.filter((q) =>
    (q.type === 'MCQ' || q.type === 'TF') && parseJsonArray(q.distractorRationales).length === 0
  ).length
  if (missingDistractors > 0) errors.push(`${missingDistractors} سؤالاً موضوعياً بلا سبب خطأ للخيارات الأخرى.`)

  return errors.slice(0, 8)
}
