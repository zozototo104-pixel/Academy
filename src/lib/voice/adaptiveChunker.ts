/**
 * AdaptiveChunker — تقسيم بث LLM المتدفق إلى مقاطع دلالية للـTTS.
 * يقسم عند نهايات الأفكار والفواصل المنطقية — ليس كل عدد أحرف ثابت —
 * ويوازن بين زمن الاستجابة (إصدار مبكر) واستمرارية النبرة (عدم التقطيع الصغير).
 *
 * قواعد الإصدار:
 *  - نهاية جملة قوية (. ! ? ۔ :) وطول ≥ MIN_SENTENCE → أصدر
 *  - فاصلة متوسطة (، ؛) وطول ≥ MIN_CLAUSE → أصدر
 *  - طول ≥ FORCE_MAX عند حدود كلمة → أجِب إصداراً (حماية من الجمل اللانهائية)
 *  - الكسور الأقصر من MIN_SENTENCE تبقى معلقة وتندمج مع التالي (منع الصوت المتقطع)
 */
export class AdaptiveChunker {
  private buf = ''
  /** آخر ما أُصدر — للاستخدام في إلغاء الكلام عند المقاطعة */
  emittedTotal = ''

  constructor(
    private onChunk: (chunk: string, isFinal: boolean) => void,
    private opts = { minSentence: 18, minClause: 45, forceMax: 110 }
  ) {}

  /** تغذية برموز LLM المتدفقة */
  feed(delta: string) {
    this.buf += delta
    this.tryFlush(false)
  }

  /** نهاية بث LLM — إصدار كل ما تبقى */
  end() {
    const rest = this.buf.trim()
    this.buf = ''
    if (rest) {
      this.emittedTotal += rest
      this.onChunk(rest, true)
    } else {
      // لا شيء متبقٍ — لا نطلق chunk فارغاً
    }
  }

  /** النص المعلّق غير المُصدر بعد (للمقاطعة) */
  pending(): string {
    return this.buf
  }

  private tryFlush(final: boolean) {
    const { minSentence, minClause, forceMax } = this.opts
    // نبحث عن أول حد إصدار مناسب — الإصدار المبكر يقلل زمن أول صوت
    while (true) {
      const s = this.buf
      if (!s.trim()) { this.buf = ''; return }

      // أول حد قوي (نهاية جملة) يتجاوز الحد الأدنى
      const strongRe = /[.!?؟۔:]+["»)\]]*\s/g
      let strongPos = -1
      let m: RegExpExecArray | null
      while ((m = strongRe.exec(s))) {
        strongPos = m.index + m[0].length
        if (strongPos >= minSentence) break
      }

      // أول حد متوسط (فاصلة) يتجاوز حدوده
      const midRe = /[،؛…]\s/g
      let midPos = -1
      while ((m = midRe.exec(s))) {
        midPos = m.index + m[0].length
        if (midPos >= minClause) break
      }

      if (strongPos >= minSentence) {
        this.emit(s.slice(0, strongPos))
        this.buf = s.slice(strongPos)
        continue
      }
      if (midPos >= minClause) {
        this.emit(s.slice(0, midPos))
        this.buf = s.slice(midPos)
        continue
      }
      // حماية الجمل الطويلة جداً — قسِم عند حدود كلمة قريبة من forceMax
      if (s.length > forceMax) {
        let cut = s.lastIndexOf(' ', forceMax)
        if (cut < minSentence) cut = forceMax
        this.emit(s.slice(0, cut))
        this.buf = s.slice(cut)
        continue
      }
      return // لا يوجد إصدار مناسب الآن — انتظر المزيد
    }
  }

  private emit(text: string) {
    const clean = text.trim()
    if (!clean) return
    this.emittedTotal += clean + ' '
    this.onChunk(clean, false)
  }
}
