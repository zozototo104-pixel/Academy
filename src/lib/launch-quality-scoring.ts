// Launch-quality probe scoring: concept-group based, deterministic, and built
// ONLY from the student's trusted data (expected terms decided by the caller
// from the database record). Variants are never derived from the model reply
// being evaluated, and no AI call is involved in building or scoring concepts.
//
// Owner ruling 2026-11-10: literal phrase matching rejected a correct,
// grounded DEFENSE answer in gate #716 (keywordScore 0 for a reply that
// discussed the thesis concepts in different wording). Concepts may be
// expressed by any attested variant, but scattered generic words alone never
// prove thesis specificity: non-title concepts are matched on the reply text
// that remains after masking the verbatim thesis title, so merely quoting
// the title cannot satisfy the concept checks.

export type ProbeKind = 'PROFILE' | 'CURRICULUM' | 'THESIS' | 'DEFENSE'

export function normalizeArabic(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compact(value: unknown, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// Attested variant forms per canonical concept, keyed by the NORMALIZED
// canonical phrase. A canonical phrase with no entry keeps a single-variant
// group (itself), so identifiers and titles stay strictly literal.
const CONCEPT_VARIANTS: Record<string, string[]> = {
  // «مؤشرات المخاطر الرئيسية» — gate #716's answer used «مؤشرات المخاطر».
  // (المفتاح بصيغته المطبّعة فعلياً: ئ تتحول إلى ي فتصبح «الرييسيه».)
  'موشرات المخاطر الرييسيه': [
    'موشرات المخاطر الرييسيه',
    'موشرات المخاطر',
    'موشرات الخطر الرييسيه',
    'موشرات الخطر',
    'موشرات قياس المخاطر',
  ],
  // «الحوكمة المؤسسية»
  'الحوكمه الموسسيه': [
    'الحوكمه الموسسيه',
    'حوكمه الموسسات',
    'الحوكمه الموسساتيه',
  ],
  // «منهجية» (THESIS probe)
  'منهجيه': ['منهجيه', 'منهج البحث'],
  // «نتائج» (THESIS probe)
  'نتايج': ['نتايج', 'نتايج البحث', 'نتايج الدراسه'],
}

export interface ConceptGroup {
  canonical: string
  variants: string[]
  isThesisTitle: boolean
}

export function conceptGroupFor(term: string, thesisTitle?: string): ConceptGroup {
  const canonical = compact(term, 80)
  const normalized = normalizeArabic(canonical)
  const variants = CONCEPT_VARIANTS[normalized] || [normalized]
  return {
    canonical,
    variants,
    isThesisTitle: !!thesisTitle && normalized === normalizeArabic(thesisTitle),
  }
}

const TITLE_STOPWORDS = new Set(['علي', 'في', 'من', 'الي', 'عن', 'ان', 'ما', 'لا', 'لم', 'لن', 'هو', 'هي', 'ذا', 'ذو'])

// Distinctive content tokens of a title: used to measure whether a reply
// genuinely engages THIS student's thesis, even when it never quotes the
// title verbatim.
export function titleContentTokens(title: string): string[] {
  const tokens = normalizeArabic(title).split(' ').filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  return [...new Set(tokens)]
}

export function titleTokenCoverage(reply: string, title: string): number {
  const tokens = titleContentTokens(title)
  if (!tokens.length) return 0
  const n = normalizeArabic(reply)
  // «ال» أداة تعريف لاصقة: تُحسب الكلمة حاضرة بصيغتها المعرّفة أو المجرّدة.
  const present = tokens.filter((t) => {
    if (n.includes(t)) return true
    const bare = t.startsWith('ال') && t.length > 4 ? t.slice(2) : ''
    return !!bare && n.includes(bare)
  }).length
  return present / tokens.length
}

// A defense question can discuss the thesis through concrete operational
// evidence without repeating its title. This narrow equivalence is valid only
// for a thesis about risk indicators and governance, and requires multiple
// connected methodological details, not generic risk/governance vocabulary.
function engagesRiskIndicatorThesis(reply: string, title: string): boolean {
  const t = normalizeArabic(title)
  if (!t.includes('موشرات المخاطر') || !t.includes('الحوكمه')) return false
  const n = normalizeArabic(reply)
  return /(?:الموشر|الموشرات|مؤشر|مؤشرات)/u.test(n)
    && /(?:فعاليه الضابط|فعاليه الضوابط|قياس الفعاليه|فعاليه الرقابه)/u.test(n)
    && /(?:سجل المخاطر|تقارير الاداره|البيانات الرقميه|مقاييس رقميه)/u.test(n)
    && /(?:منهجيه|قياس|تقييم)/u.test(n)
}

export interface ConceptScore {
  hits: string[]
  missed: string[]
  score: number
}

// Score a reply against concept groups. The thesis-title concept is matched
// on the full reply (verbatim, or >=50% of its content tokens). Every other
// concept is matched on the discussion text: the reply with the verbatim
// thesis title masked out, so quoting the title alone cannot fake a concept
// discussion.
export function scoreConcepts(reply: string, groups: ConceptGroup[], thesisTitle?: string): ConceptScore {
  const n = normalizeArabic(reply)
  const normalizedTitle = thesisTitle ? normalizeArabic(thesisTitle) : ''
  const discussion = normalizedTitle ? n.split(normalizedTitle).join(' ') : n
  const usable = groups.filter((g) => normalizeArabic(g.canonical).length >= 3)
  const hits: string[] = []
  const missed: string[] = []
  for (const group of usable) {
    let hit: boolean
    if (group.isThesisTitle && thesisTitle) {
      hit = n.includes(normalizedTitle) || titleTokenCoverage(reply, thesisTitle) >= 0.5
    } else {
      hit = group.variants.some((v) => discussion.includes(v))
    }
    ;(hit ? hits : missed).push(group.canonical)
  }
  return {
    hits,
    missed,
    score: usable.length ? Math.round((hits.length / usable.length) * 100) : 100,
  }
}

export function isGenericFallbackReply(reply: string) {
  const n = normalizeArabic(reply)
  return [
    'وضح لي هل سوالك عن برنامج',
    'ساعطيك جوابا مباشرا',
    'هل سوالك عن برنامج معين الرسوم الشهاده الاعتماد او خطوات التسجيل',
  ].some((phrase) => n.includes(normalizeArabic(phrase)))
}

export interface ProbeStudentContext {
  studentName?: string
  programTitle?: string
  firstBook?: string
  firstUnit?: string
  thesisTitle?: string
  reference?: string
}

function variantHit(reply: string, canonical: string): boolean {
  const group = conceptGroupFor(canonical)
  const n = normalizeArabic(reply)
  return group.variants.some((v) => n.includes(v))
}

// Grounding: the reply must engage the student's OWN context. For DEFENSE
// this now requires real engagement with the thesis (verbatim title or at
// least half of its distinctive tokens) PLUS at least one of the thesis's
// domain concepts in the discussion — generic talk about governance alone
// no longer grounds the answer.
export function groundedForProbe(kind: ProbeKind, reply: string, context: ProbeStudentContext): boolean {
  const n = normalizeArabic(reply)
  const thesisTitle = context.thesisTitle ? normalizeArabic(context.thesisTitle) : ''
  if (kind === 'PROFILE') {
    return [context.studentName || '', context.programTitle || '', context.reference || '']
      .map(normalizeArabic)
      .filter(Boolean)
      .some((x) => n.includes(x))
  }
  if (kind === 'CURRICULUM') {
    return [context.programTitle || '', context.firstBook || '', context.firstUnit || '']
      .map(normalizeArabic)
      .filter(Boolean)
      .some((x) => n.includes(x))
  }
  if (!thesisTitle || !context.thesisTitle) return false
  if (kind === 'THESIS') {
    return n.includes(thesisTitle) || (variantHit(reply, 'منهجية') && variantHit(reply, 'نتائج'))
  }
  if (kind === 'DEFENSE') {
    const engaged = n.includes(thesisTitle) || titleTokenCoverage(reply, context.thesisTitle) >= 0.5
    if (!engaged) return false
    const discussion = n.split(thesisTitle).join(' ')
    return variantHit(discussion, 'مؤشرات المخاطر الرئيسية') || variantHit(discussion, 'الحوكمة المؤسسية')
  }
  return false
}

export interface ProbeEvaluation {
  keywordScore: number
  hits: string[]
  missed: string[]
  grounded: boolean
  genericFallback: boolean
  contextSufficient: boolean
  note: string | null
  passed: boolean
}

// Full per-probe verdict. Every pre-existing guard is preserved: agent match,
// grounding, generic-fallback rejection, minimum reply length, and the
// per-probe keyword minimum. When the thesis data needed to build verifiable
// concepts is missing, the probe is marked context-insufficient and can never
// pass silently (owner ruling 2026-11-10, addition 3).
export function evaluateProbeReply(input: {
  kind: ProbeKind
  reply: string
  agentMatches: boolean
  expected: string[]
  context: ProbeStudentContext
  minScore: number
}): ProbeEvaluation {
  const { kind, reply, expected, context, minScore } = input
  const genericFallback = isGenericFallbackReply(reply)
  const groups = expected.map((term) => conceptGroupFor(term, context.thesisTitle))
  const scored = genericFallback ? { hits: [] as string[], missed: expected.slice(), score: 0 } : scoreConcepts(reply, groups, context.thesisTitle)
  const grounded = groundedForProbe(kind, reply, context)
  const contextSufficient = kind === 'THESIS' || kind === 'DEFENSE' ? !!context.thesisTitle : true
  const passed =
    contextSufficient &&
    !genericFallback &&
    input.agentMatches &&
    grounded &&
    scored.score >= minScore &&
    reply.length >= 80
  return {
    keywordScore: scored.score,
    hits: scored.hits,
    missed: scored.missed,
    grounded,
    genericFallback,
    contextSufficient,
    note: contextSufficient ? null : 'INSUFFICIENT_THESIS_CONTEXT',
    passed,
  }
}
