/**
 * VoiceActivityDetector — كشف النشاط الصوتي من المايك بطاقة RMS
 * مع أرضية ضوضاء تكيفية (EMA) وتحبّى hysterisis وحدود زمنية دنيا.
 *
 * - يعمل دائماً حتى أثناء نطق الخبير (Full Duplex) — AEC في المتصفح
 *   (echoCancellation:true) يزيل صوت السماعات من المايك.
 * - onSpeechStart / onSpeechEnd يغذيان End-of-Turn و Barge-in.
 * - مستوى لحظي level (0..1) لتجريد الواجهة.
 */
export interface VadOptions {
  speechStartFactor?: number // مضاعف أرضية الضوضاء لبدء الكلام
  speechStopFactor?: number // مضاعف للبقاء في الكلام
  minSpeechMs?: number // حد أدنى لاعتبار الومضة كلاماً حقيقياً (debounce)
  minSilenceMs?: number // حد أدنى للصمت قبل إعلان النهاية
}

export class VoiceActivityDetector {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private raf = 0
  private timeData: Float32Array = new Float32Array(1024)

  private noiseFloor = 0.008
  private speechCandidateStart = 0
  private speechStartedAt = 0
  private lastVoiceAt = 0
  private inSpeech = false

  level = 0
  onSpeechStart?: () => void
  onSpeechEnd?: (durationMs: number) => void
  /** مستوى صوت لحظي خام (قد يُستخدم لثقة الـbarge-in) */
  onFrame?: (rms: number, inSpeech: boolean) => void

  constructor(private opts: VadOptions = {}) {}

  static async create(opts?: VadOptions): Promise<VoiceActivityDetector> {
    const v = new VoiceActivityDetector(opts)
    await v.init()
    return v
  }

  private async init() {
    // قيود AEC الأساسية — بدونها يعود صوت الخبير للمايك ويقاطع نفسه
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
    this.ctx = new Ctx() as AudioContext
    const ctx = this.ctx as AudioContext
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    this.source = ctx.createMediaStreamSource(this.stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.source.connect(this.analyser) // لا نخرج للسماعات — تحليل فقط
    this.loop()
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate || 48000
  }

  private loop = () => {
    const analyser = this.analyser
    if (!analyser) return
    analyser.getFloatTimeDomainData(this.timeData as any)
    let sum = 0
    for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] * this.timeData[i]
    const rms = Math.sqrt(sum / this.timeData.length)

    // أرضية ضوضاء تكيفية: تتبع المستوى المنخفض ببطء (EMA) ولا ترتفع أثناء الكلام
    if (!this.inSpeech) {
      this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03
    }
    this.level = Math.min(1, rms * 14)

    const startTh = Math.max(this.noiseFloor * (this.opts.speechStartFactor ?? 3.1), this.noiseFloor + 0.014)
    const stopTh = Math.max(this.noiseFloor * (this.opts.speechStopFactor ?? 1.9), this.noiseFloor + 0.008)
    const now = performance.now()

    if (!this.inSpeech) {
      if (rms > startTh) {
        if (!this.speechCandidateStart) this.speechCandidateStart = now
        // debounce: كلام مستمر فقط — ليست ومضة نقرة/ضوضاء
        if (now - this.speechCandidateStart >= (this.opts.minSpeechMs ?? 220)) {
          this.inSpeech = true
          this.speechStartedAt = this.speechCandidateStart
          this.lastVoiceAt = now
          this.onSpeechStart?.()
        }
      } else {
        this.speechCandidateStart = 0
      }
    } else {
      if (rms > stopTh) this.lastVoiceAt = now
      else if (now - this.lastVoiceAt >= (this.opts.minSilenceMs ?? 260)) {
        this.inSpeech = false
        this.speechCandidateStart = 0
        const dur = now - this.speechStartedAt
        if (dur >= (this.opts.minSpeechMs ?? 220)) this.onSpeechEnd?.(dur)
      }
    }

    this.onFrame?.(rms, this.inSpeech)
    this.raf = requestAnimationFrame(this.loop)
  }

  get isSpeaking(): boolean {
    return this.inSpeech
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    try { this.source?.disconnect() } catch {}
    try { await0(this.ctx) } catch {}
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx = null
    this.analyser = null
  }
}

async function await0(ctx: AudioContext | null) {
  try { await ctx?.close() } catch {}
}
