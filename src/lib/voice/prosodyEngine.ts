import { normalizeForSpeech } from './arabicNormalizer'

/**
 * ProsodyEngine — طبقة عرض الكلام بين LLM وTTS.
 * تصنّف كل مقطع (سؤال/تأكيد/تحذير/شرح/تردد...) ويستخرج:
 *  - speaking rate (سرعة مناسبة للسياق)
 *  - pause duration (وقفة بعد المقطع حسب علامته)
 *  - emotion/tone تلميحي (يمرر للمحرك إن دعم مستقبلاً)
 * الطبيعية تأتي من: الترقيم المحفوظ + الوقفات المعتمدة على المعنى + السرعات المتغيرة.
 */

export type ToneType = 'QUESTION' | 'CONFIRM' | 'HESITANT' | 'WARNING' | 'EXPLAIN' | 'GOODNEWS' | 'NEUTRAL'

export interface ProsodyPlan {
  /** النص الجاهز للنطق بعد التطبيع */
  speakText: string
  tone: ToneType
  /** سرعة النطق 0.8..1.3 */
  rate: number
  /** وقفة بعد المقطع بالمللي ثانية */
  pauseAfterMs: number
}

const CONFIRM_WORDS = /^(تمام|آه|اه|صح|صحيح|بالضبط|ممتاز|طيب|لا|أيوه|ايوه|هيك|أكيد|اكيد|ممم|عين|معك|معك حق)[!.،؟\s]*/i
const HESITANT_RE = /^(ممم|آه\.\.|اه\.\.|يعني|لحظة|خليني|خلي ني|ممكن|بس)/i
const WARNING_RE = /(انتبه|احذر|خلي بالك|خلّي بالك|انتبه|مهم جدا|تحذير)/i
const GOOD_RE = /(مبروك|ممتاز جدا|أحسنت|مبسوط|رائع|تهانينا|نجحت|مقبول|تم القبول)/i
const EXPLAIN_RE = /(لأن|بينما|حيث|السبب|يعني|مثلا|مثلاً|على سبيل|خطوة|المرحلة)/

export function planProsody(rawChunk: string): ProsodyPlan {
  let text = normalizeForSpeech(rawChunk)
  // "…" تتحول إلى فاصلة مع وقفة أطول — لا نطق للنقاط حرفياً
  const hadEllipsis = text.includes('…') || /\.{2,}/.test(text)
  text = text.replace(/…|\.{2,}/g, '،').replace(/،\s*،/g, '،').trim()

  const endsQ = /[؟?]\s*$/.test(text)
  const endsStrong = /[.!؟?]\s*$/.test(text)
  const endsComma = /[،؛]\s*$/.test(text)
  const wordCount = text.split(/\s+/).filter(Boolean).length

  let tone: ToneType = 'NEUTRAL'
  if (endsQ || /^(هل|ليش|لماذا|كيف|شو|ايش|وين|متى|قديش|كم)\b/i.test(text)) tone = 'QUESTION'
  else if (wordCount <= 3 && CONFIRM_WORDS.test(text)) tone = 'CONFIRM'
  else if (hadEllipsis || HESITANT_RE.test(text)) tone = 'HESITANT'
  else if (WARNING_RE.test(text)) tone = 'WARNING'
  else if (GOOD_RE.test(text)) tone = 'GOODNEWS'
  else if (wordCount > 8 && EXPLAIN_RE.test(text)) tone = 'EXPLAIN'

  // السرعة: التأكيدات أسرع قليلاً، الشرح والتحذير أهدأ، السؤال طبيعي بانحدار خفيف
  let rate = 1.0
  switch (tone) {
    case 'CONFIRM': rate = 1.1; break
    case 'QUESTION': rate = 0.99; break
    case 'HESITANT': rate = 0.93; break
    case 'WARNING': rate = 0.94; break
    case 'EXPLAIN': rate = 0.97; break
    case 'GOODNEWS': rate = 1.04; break
  }

  // الوقفة بعد المقطع — حسب المعنى وعلامته النهائية
  let pauseAfterMs: number
  if (endsQ) pauseAfterMs = 430 // يترك مجالاً حقيقياً للإجابة
  else if (endsStrong) pauseAfterMs = tone === 'CONFIRM' ? 300 : 420
  else if (endsComma) pauseAfterMs = tone === 'HESITANT' ? 380 : 210
  else pauseAfterMs = 260 // مقطع مبتور — وقفة قصيرة محايدة

  // التردد يزيد وقفته الأولية قليلاً (آه… فهمت عليك)
  if (tone === 'HESITANT' && hadEllipsis) pauseAfterMs = Math.max(pauseAfterMs, 320)

  return { speakText: text, tone, rate, pauseAfterMs }
}
