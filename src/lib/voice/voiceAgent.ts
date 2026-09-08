import { LatencyTracker } from './latency'
import { VoiceStateMachine, VoiceState } from './voiceStateMachine'
import { VoiceActivityDetector } from './vad'
import { EndOfTurnDetector } from './endOfTurn'
import { AdaptiveChunker } from './adaptiveChunker'
import { planProsody } from './prosodyEngine'
import { StreamingTtsPlayer } from './streamingPlayer'

/**
 * VoiceAgent — وكيل محادثة صوتي حي ثنائي الاتجاه (Full Duplex).
 *
 * المسار: مايك (AEC) → VAD تكيفي → STT (interim حي) → End-of-Turn ذكي
 *        → LLM streaming → Semantic Chunker → Prosody → TTS streaming
 *        → مشغل متواصل — بينما VAD يبقى سامعاً للمقاطعة الحقيقية (Barge-in).
 *
 * آلة حالة واحدة (مصدر حقيقة وحيد) + قياس زمن كل مرحلة.
 */

export interface AgentCallbacks {
  onState?: (s: VoiceState) => void
  onLevel?: (level: number) => void // طاقة المايك 0..1 للواجهة
  onUserCaption?: (text: string) => void // نص المستخدم المؤقت الحي
  onAiCaption?: (fullTextSoFar: string) => void // نص الخبير المتدفق الحي
  onTimings?: (rows: { event: string; atMs: number }[]) => void
  onTurnComplete?: (turn: { userText: string; aiText: string; messageId?: string }) => void
  onInterrupted?: (info: { spokenPartial: string }) => void
  onError?: (msg: string) => void
}

function getToken(): string {
  try { return localStorage.getItem('aact_token') || '' } catch { return '' }
}

export class VoiceAgent {
  private fsm = new VoiceStateMachine()
  private latency = new LatencyTracker()
  private vad: VoiceActivityDetector | null = null
  private eot = new EndOfTurnDetector()
  private player = new StreamingTtsPlayer()
  private rec: any = null
  private recActive = false
  private evaluator: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  // حالة الدور الحالي
  private finalText = '' // نتائج STT النهائية المتراكمة
  private interimText = ''
  private lastAsrText = ''
  private submittedText = ''
  private followUp = '' // كلام المستخدم أثناء التفكير — يُرسل بعد الرد
  private streaming = false
  private streamAbort: AbortController | null = null
  private chunker: AdaptiveChunker | null = null
  private aiFullText = ''
  private aiSpokenText = '' // ما نُطق فعلاً قبل أي مقاطعة
  private playbackStartedAt = 0
  private lastChunker: AdaptiveChunker | null = null

  // مقاطعة
  private interimDuringSpeech = ''
  private interruptNote = ''
  /** كلام المستخدم المُلتقط أثناء نطق الخبير — يُعتمد عند المقاطعة */
  private pendingSpeechTail = ''

  active = false
  muted = false
  private cb: AgentCallbacks

  constructor(cb: AgentCallbacks) {
    this.cb = cb
    this.fsm.onChange((s) => this.cb.onState?.(s))
    this.latency.onTurnComplete = (rows) => this.cb.onTimings?.(rows)
  }

  get state(): VoiceState {
    return this.fsm.current
  }

  // ===== بدء/إنهاء الجلسة =====
  async start() {
    if (this.active) return
    this.active = true
    this.fsm.reset()
    this.vad = await VoiceActivityDetector.create({ minSpeechMs: 220, minSilenceMs: 240 })
    this.vad.onFrame = (_rms, inSpeech) => {
      this.cb.onLevel?.(this.vad?.level || 0)
      if (!inSpeech) return
      // مستخدم يتكلم الآن
      if (this.fsm.is('LISTENING')) this.fsm.to('USER_SPEAKING')
      // أثناء نطق الخبير: مرشّح مقاطعة — VAD مع debounce مدمج (220ms)
      if (this.fsm.is('AI_SPEAKING')) this.tryBargeIn()
    }
    this.vad.onSpeechStart = () => {
      if (this.fsm.is('LISTENING')) this.fsm.to('USER_SPEAKING')
    }
    this.vad.onSpeechEnd = () => {
      if (this.fsm.is('USER_SPEAKING')) this.fsm.to('LISTENING')
      this.eot.onSpeechEnded()
    }
    this.eot.beginTurn()
    this.startRecognition()
    this.evaluator = setInterval(() => this.evaluateTurn(), 120)
    this.fsm.to('LISTENING')
  }

  async stop() {
    this.active = false
    this.fsm.to('IDLE')
    if (this.evaluator) { clearInterval(this.evaluator); this.evaluator = null }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    try { this.rec?.abort() } catch {}
    this.rec = null
    this.streamAbort?.abort()
    this.streamAbort = null
    this.player.destroy()
    try { await this.vad?.destroy() } catch {}
    this.vad = null
  }

  setMuted(m: boolean) {
    this.muted = m
    if (m) {
      try { this.rec?.abort() } catch {}
      this.player.stop(20)
      if (this.fsm.is('AI_SPEAKING', 'USER_SPEAKING')) this.fsm.to('LISTENING')
    } else if (this.active) {
      this.startRecognition()
    }
  }

  /** مقاطعة يدوية من زر الواجهة */
  interrupt() {
    if (this.fsm.is('AI_SPEAKING')) this.doBargeIn('manual')
  }

  // ===== STT: Web Speech حي + بديل خادمي =====
  private getSpeechRec(): any | null {
    const w = window as any
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SR) return null
    const rec = new SR()
    rec.lang = 'ar-SA'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    return rec
  }

  private startRecognition() {
    if (!this.active || this.muted) return
    if (!this.rec) this.rec = this.getSpeechRec()
    if (!this.rec) { this.startServerAsrFallback(); return }
    const rec = this.rec

    rec.onresult = (e: any) => {
      let finalPart = ''
      let interimPart = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalPart += r[0].transcript
        else interimPart += r[0].transcript
      }
      // حماية صدى: أثناء نطق الخبير لا نغذي finalText مباشرة —
      // تسرب صوت السماعات (على الرغم من AEC) قد يُسجّل ككلام مستخدم.
      if (this.fsm.is('AI_SPEAKING')) {
        if (interimPart.trim()) {
          this.interimDuringSpeech = interimPart.trim()
          this.latency.mark('STT_PARTIAL')
          this.cb.onUserCaption?.(this.interimDuringSpeech)
        }
        if (finalPart.trim()) {
          const tail = (this.aiSpokenText || '').slice(-120)
          const fp = finalPart.trim()
          // تجاهل ما يشبه حديث الخبير نفسه (صدى STT)
          const echo = tail.length > 30 && (tail.includes(fp) || fp.includes(tail.slice(-Math.min(tail.length, fp.length))))
          if (!echo) this.pendingSpeechTail = (this.pendingSpeechTail + ' ' + fp).trim()
        }
        return
      }
      if (finalPart.trim()) {
        this.finalText += ' ' + finalPart.trim()
        this.latency.mark('STT_FINAL')
      }
      if (interimPart.trim()) {
        this.interimText = interimPart.trim()
        this.latency.mark('STT_PARTIAL')
        this.eot.onInterim(this.interimText)
        this.cb.onUserCaption?.((this.finalText + ' ' + this.interimText).trim())
      }
    }
    rec.onerror = (ev: any) => {
      if (ev?.error === 'not-allowed') {
        this.cb.onError?.('صلاحية المايكروفون مرفوضة — اسمح بها من إعدادات المتصفح')
        this.stop()
      }
    }
    rec.onend = () => {
      this.recActive = false
      if (this.active && !this.muted) {
        // حلقة استمرار — المتصفح يوقف التعرف دورياً
        this.restartTimer = setTimeout(() => this.startRecognition(), 250)
      }
    }
    try { rec.start(); this.recActive = true } catch {}
  }

  /** بديل خادمي: تسجيل مقاطع VAD → ASR (لمتصفحات بلا Web Speech) */
  private serverAsr: { recorder: MediaRecorder | null } = { recorder: null }
  private startServerAsrFallback() {
    void this.serverAsr
    this.cb.onError?.('متصفحك لا يدعم التعرف الصوتي الحي — الوضع الصوتي يحتاج Chrome/Safari حديث')
    this.stop()
  }

  // ===== قرار نهاية الدور =====
  private evaluateTurn() {
    if (!this.active || this.streaming) return
    if (!this.fsm.is('LISTENING', 'USER_SPEAKING')) return
    const text = (this.finalText + ' ' + this.interimText).trim()
    const decision = this.eot.evaluate(text)
    if (decision.shouldEndTurn && text) {
      this.submitTurn(text)
    }
  }

  // ===== دور كامل: LLM streaming → chunker → prosody → TTS stream → player =====
  private async submitTurn(text: string) {
    if (this.streaming) return
    this.finalText = ''
    this.interimText = ''
    this.eot.reset()
    this.eot.beginTurn()
    this.fsm.to('THINKING')
    this.cb.onUserCaption?.(text)
    this.streaming = true
    this.submittedText = text
    this.aiFullText = ''
    this.aiSpokenText = ''
    this.interimDuringSpeech = ''
    this.latency.start()

    this.chunker = new AdaptiveChunker((chunk) => void this.speakChunk(chunk), { minSentence: 18, minClause: 45, forceMax: 110 })
    this.lastChunker = this.chunker

    this.streamAbort = new AbortController()
    let llmDone = false
    try {
      const res = await fetch('/api/ai/voice-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ message: text, interruptNote: this.interruptNote || undefined }),
        signal: this.streamAbort.signal,
      })
      this.interruptNote = ''
      if (!res.ok || !res.body) throw new Error('HTTP_' + res.status)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let sseBuf = ''
      let errored: string | null = null
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuf += decoder.decode(value, { stream: true })
        const lines = sseBuf.split('\n')
        sseBuf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          try {
            const ev = JSON.parse(t.slice(5).trim())
            if (ev.type === 'delta' && ev.text) {
              this.latency.mark('LLM_FIRST_TOKEN')
              this.aiFullText += ev.text
              this.cb.onAiCaption?.(this.aiFullText)
              this.chunker!.feed(ev.text)
            } else if (ev.type === 'done') {
              llmDone = true
              if (ev.messageId) this.setLastMessageId(ev.messageId)
              this.chunker!.end()
              // نهاية الرد تنشر عبر انتهاء التشغيل (أسفل)
            } else if (ev.type === 'error') {
              errored = ev.error || 'خطأ'
            }
          } catch {}
        }
      }
      if (errored) throw new Error(errored)
      if (!llmDone) this.chunker!.end()
    } catch (e: any) {
      if (e?.name === 'AbortError') return // مقُوطع — لا شيء
      this.cb.onError?.(e?.message || 'تعذر الاتصال بالخبير')
      this.streaming = false
      if (this.fsm.is('THINKING')) this.fsm.to('LISTENING')
      return
    }

    // انتظر انتهاء التشغيل الطبيعي (إن لم تُقاطع)
    await this.waitForPlaybackEnd()
    if (this.streamAbort?.signal.aborted) return
    this.streaming = false
    this.latency.mark('TURN_COMPLETE')
    this.cb.onTurnComplete?.({ userText: this.submittedText, aiText: this.aiFullText, messageId: this.lastMessageId || undefined })
    this.lastMessageId = null
    // كلام تراكم أثناء التفكير/النطق بعد انتهاء الرد — دور جديد فوراً
    if (this.followUp.trim()) {
      const fu = this.followUp.trim()
      this.followUp = ''
      setTimeout(() => this.submitTurn(fu), 150)
      return
    }
    if (this.active) this.fsm.to('LISTENING')
  }

  private lastMessageId: string | null = null
  private setLastMessageId(id: string) { this.lastMessageId = id }

  private playbackEndResolve: (() => void) | null = null
  private waitForPlaybackEnd(): Promise<void> {
    if (!this.player.playing && !this.ttsInFlight) return Promise.resolve()
    return new Promise((resolve) => {
      this.playbackEndResolve = resolve
    })
  }

  private maybeResolvePlaybackEnd() {
    if (this.playbackEndResolve && !this.player.playing && !this.ttsInFlight) {
      const r = this.playbackEndResolve
      this.playbackEndResolve = null
      r()
    }
  }

  // ===== نطق مقطع: prosody → TTS streaming → player =====
  private ttsInFlight = 0
  private speakQueue: Promise<void> = Promise.resolve()

  private speakChunk(chunk: string) {
    // تسلسل صارم: مقطع واحد يُنطق في كل لحظة — الطوابير لاحقاً تحافظ على الترتيب
    this.speakQueue = this.speakQueue.then(() => this.speakChunkNow(chunk))
  }

  private async speakChunkNow(chunk: string) {
    if (!this.active || this.streamAbort?.signal.aborted) return
    const plan = planProsody(chunk)
    if (!plan.speakText) return
    this.ttsInFlight++
    const player = this.player
    const prevFirst = player.hooks.onFirstChunk
    const prevStart = player.hooks.onPlaybackStart
    const prevEnd = player.hooks.onPlaybackEnd
    player.hooks.onFirstChunk = () => { prevFirst?.(); this.latency.mark('TTS_FIRST_CHUNK') }
    player.hooks.onPlaybackStart = () => {
      prevStart?.()
      this.playbackStartedAt = performance.now()
      this.latency.mark('AUDIO_PLAYBACK_START')
      if (this.fsm.is('THINKING', 'LISTENING', 'INTERRUPTED')) this.fsm.to('AI_SPEAKING')
    }
    player.hooks.onPlaybackEnd = () => {
      prevEnd?.()
      this.maybeResolvePlaybackEnd()
    }
    try {
      await player.playTtsStream('/api/ai/tts-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ text: plan.speakText, speed: plan.rate }),
      })
      this.aiSpokenText += chunk + ' '
      if (plan.pauseAfterMs > 0) player.pushSilence(plan.pauseAfterMs)
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      console.error('speakChunk failed:', e?.message)
    } finally {
      this.ttsInFlight--
      // أعِد الخطافات الأصلية فقط إن لم تغيّرها مقطع تالٍ
      if (player.hooks.onFirstChunk === undefined) player.hooks.onFirstChunk = prevFirst
      this.maybeResolvePlaybackEnd()
    }
  }

  // ===== Barge-in — مقاطعة حقيقية بثقة =====
  private lastBargeInAt = 0

  private tryBargeIn() {
    const now = performance.now()
    // حماية صدى: لا مقاطعة في أول 500ms من النطق ولا مرتين خلال 700ms
    if (now - this.playbackStartedAt < 500) return
    if (now - this.lastBargeInAt < 700) return
    // ثقة: VAD مكتمل debounce (220ms كلام مستمر) + (نص مؤقت جديد أثناء النطق أو كلام عالٍ)
    const hasInterim = this.interimDuringSpeech.trim().length >= 2
    const loud = (this.vad?.level || 0) > 0.18
    if (!hasInterim && !loud) return // لا ثقة كافية — غالباً صدى/ضوضاء
    this.doBargeIn(hasInterim ? 'stt+vad' : 'vad')
  }

  private doBargeIn(source: string) {
    if (!this.fsm.is('AI_SPEAKING')) return
    this.lastBargeInAt = performance.now()
    console.debug(`[VOICE-BARGE-IN] via ${source}`)
    // احتفظ بما قاله الخبير فعلاً قبل المقاطعة
    const spokenPartial = this.aiSpokenText.trim() || this.lastChunker?.emittedTotal?.trim() || ''
    this.player.stop(30)
    this.streamAbort?.abort() // أوقف بث LLM أيضاً — الرد القديم انتهى
    this.ttsInFlight = 0
    this.speakQueue = Promise.resolve()
    this.streaming = false
    if (this.playbackEndResolve) { this.playbackEndResolve(); this.playbackEndResolve = null }
    this.fsm.to('INTERRUPTED')
    // ملاحظة المقاطعة تُحقن في الدور التالي
    this.interruptNote = spokenPartial.slice(-180)
    this.cb.onInterrupted?.({ spokenPartial })
    // كلام المستخدم الذي قاطع — يبقى نص الدور التالي
    this.finalText = this.pendingSpeechTail
    this.pendingSpeechTail = ''
    this.interimText = ''
    this.eot.reset()
    this.eot.beginTurn()
    this.fsm.to('LISTENING')
  }
}
