/**
 * LatencyTracker — قياس زمن كل مرحلة في دورة المحادثة الصوتية.
 * الأحداث المطلوبة: TURN_START, STT_PARTIAL, STT_FINAL, LLM_FIRST_TOKEN,
 * TTS_FIRST_CHUNK, AUDIO_PLAYBACK_START, TURN_COMPLETE
 * الإخراج: سطر console واضح مع الزمن التراكمي لكل مرحلة — لا إخفاء للتأخير.
 */
export type VoiceLatencyEvent =
  | 'TURN_START'
  | 'STT_PARTIAL'
  | 'STT_FINAL'
  | 'LLM_FIRST_TOKEN'
  | 'TTS_FIRST_CHUNK'
  | 'AUDIO_PLAYBACK_START'
  | 'TURN_COMPLETE'

export class LatencyTracker {
  private t0 = 0
  private marks = new Map<string, number>()
  /** آخر دورة كاملة — لعرضها في واجهة الأداء */
  lastTurn: { event: string; atMs: number }[] = []
  onTurnComplete?: (timings: { event: string; atMs: number }[]) => void

  start() {
    this.t0 = performance.now()
    this.marks.clear()
    this.lastTurn = []
    this.mark('TURN_START')
  }

  mark(event: VoiceLatencyEvent) {
    if (event === 'TURN_START') return this.start()
    if (this.marks.has(event)) return // أول حدث فقط لكل مرحلة
    const atMs = Math.round(performance.now() - this.t0)
    this.marks.set(event, atMs)
    this.lastTurn.push({ event, atMs })
    // سجل واضح — التأخير الحقيقي لا يُخفى
    console.debug(`[VOICE-TIMING] ${event} +${atMs}ms`)
    if (event === 'TURN_COMPLETE') {
      const line = this.lastTurn.map((m) => `${m.event}=+${m.atMs}ms`).join(' | ')
      console.debug(`[VOICE-TIMING] === TURN SUMMARY === ${line}`)
      this.onTurnComplete?.([...this.lastTurn])
    }
  }

  get(event: string): number | undefined {
    return this.marks.get(event)
  }
}
