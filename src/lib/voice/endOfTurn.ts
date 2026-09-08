/**
 * EndOfTurnDetector — يقرر متى انتهى دور المستخدم بالكلام.
 * لا يكتفي بمهلة صمت ثابتة: يجمع بين طول الصمت والاكتمال اللغوي للنص المؤقت.
 *
 * "أنا عندي مشكلة في…" + نصف ثانية صمت → لا رد (جملة غير مكتملة)
 * "أنا عندي مشكلة في تسجيل المصروفات." + صمت قصير → رد فوري
 */

// كلمات تُكمل الجملة — وجودها في النهاية يعني أن المتحدث لم ينته
const CONTINUATION_ENDINGS = [
  'في', 'على', 'من', 'إلى', 'عن', 'مع', 'أن', 'إن', 'الذي', 'التي', 'اللي',
  'و', 'أو', 'لكن', 'ثم', 'حتى', 'بعد', 'قبل', 'بين', 'تحت', 'فوق', 'هاد', 'هذا',
  'هذه', 'هلأ', 'هسا', 'لكنو', 'بس', 'يعني', 'مثلاً', 'مثلا', 'أما', 'عشان',
]

// نهايات تُعلن الاكتمال اللغوي بقوة
const COMPLETE_PUNCT = /[.!؟?۔،]$/

export interface EndOfTurnDecision {
  shouldEndTurn: boolean
  reason: 'SILENCE_COMPLETE' | 'SILENCE_INCOMPLETE' | 'PUNCTUAL_COMPLETE' | 'MAX_TURN'
  waitedMs: number
}

export class EndOfTurnDetector {
  private silenceStartedAt = 0
  private turnStartedAt = 0

  constructor(
    private opts = {
      completeSilenceMs: 520, // جملة مكتملة لغوياً → رد سريع
      incompleteSilenceMs: 1300, // جملة معلّقة → انتظار إطلاقاً للتفكير
      noTextSilenceMs: 900, // صمت بلا نص (ضوضاء/كلام قصير جداً)
      maxTurnMs: 45000,
    }
  ) {}

  beginTurn() {
    this.turnStartedAt = performance.now()
    this.silenceStartedAt = 0
  }

  /** يُستدعى مع كل نص مؤقت جديد — يعيد ضبط عداد الصمت عند نشاط النص */
  onInterim(text: string) {
    this.silenceStartedAt = 0
    void text
  }

  /** يُستدعى عند انتهاء النشاط الصوتي (VAD) */
  onSpeechEnded() {
    if (!this.silenceStartedAt) this.silenceStartedAt = performance.now()
  }

  reset() {
    this.silenceStartedAt = 0
  }

  /** يُستدعى دورياً (كل ~100ms) مع آخر نص مؤقت — يقرر هل ننهي الدور */
  evaluate(interimText: string): EndOfTurnDecision {
    const now = performance.now()
    const turnLen = now - this.turnStartedAt
    if (turnLen > this.opts.maxTurnMs) {
      return { shouldEndTurn: true, reason: 'MAX_TURN', waitedMs: turnLen }
    }
    const t = interimText.trim()
    if (!this.silenceStartedAt) {
      return { shouldEndTurn: false, reason: 'SILENCE_INCOMPLETE', waitedMs: 0 }
    }
    const silence = now - this.silenceStartedAt

    if (!t) {
      // لا نص أصلاً — ربما ضوضاء؛ انتظر حكمة
      if (silence >= this.opts.noTextSilenceMs && turnLen > 800) {
        return { shouldEndTurn: true, reason: 'SILENCE_INCOMPLETE', waitedMs: silence }
      }
      return { shouldEndTurn: false, reason: 'SILENCE_INCOMPLETE', waitedMs: silence }
    }

    const words = t.split(/\s+/).filter(Boolean)
    const lastWord = words[words.length - 1] || ''
    const punctuallyComplete = COMPLETE_PUNCT.test(t)
    const endsHanging = CONTINUATION_ENDINGS.includes(lastWord)

    // سؤال مكتمل بعلامة استفهام → أسرع رد (المستخدم ينتظر جواباً)
    if (/[؟?]$/.test(t) && silence >= Math.min(this.opts.completeSilenceMs, 420)) {
      return { shouldEndTurn: true, reason: 'PUNCTUAL_COMPLETE', waitedMs: silence }
    }
    if (punctuallyComplete && !endsHanging && words.length >= 2 && silence >= this.opts.completeSilenceMs) {
      return { shouldEndTurn: true, reason: 'PUNCTUAL_COMPLETE', waitedMs: silence }
    }
    if (endsHanging) {
      // جملة معلّقة — مهلة طويلة؛ المستخدم يفكر فقط
      if (silence >= this.opts.incompleteSilenceMs && words.length >= 2) {
        return { shouldEndTurn: true, reason: 'SILENCE_INCOMPLETE', waitedMs: silence }
      }
      return { shouldEndTurn: false, reason: 'SILENCE_INCOMPLETE', waitedMs: silence }
    }
    // نص عادي بلا علامات: اكتمال محتمل بعد صمت متوسط
    const needed = words.length >= 3 ? this.opts.completeSilenceMs + 160 : this.opts.incompleteSilenceMs
    if (silence >= needed) {
      return { shouldEndTurn: true, reason: 'SILENCE_COMPLETE', waitedMs: silence }
    }
    return { shouldEndTurn: false, reason: 'SILENCE_INCOMPLETE', waitedMs: silence }
  }
}
