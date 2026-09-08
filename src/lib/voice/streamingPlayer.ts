/**
 * StreamingTtsPlayer — مشغّل صوت متواصل (chunk-by-chunk) بلا انتظار الملف الكامل.
 * - يستقبل رابط /api/ai/tts-stream، يقرأ SSE، يفك base64 WAV deltas ويغذيها
 *   لحظياً إلى AudioWorklet (ring buffer) → تشغيل مع أول ~200ms متراكمة فقط.
 * - يفك ترويسة WAV أول مرة (sampleRate) وينشئ AudioContext بمعدل مطابق (تجميل داخلي).
 * - فجوات الجمل (prosody pauses) تُحقن كصمت مجدول داخل البث — بلا نقرات.
 * - stop(fadeMs) للمقاطعة الفورية مع خفوت قصير يمنع الطقطقة.
 */
export interface PlayerHooks {
  onFirstChunk?: () => void
  onPlaybackStart?: () => void
  onPlaybackEnd?: () => void // نهاية طبيعية (drain كامل)
}

export class StreamingTtsPlayer {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private spNode: ScriptProcessorNode | null = null // fallback
  private gain: GainNode | null = null
  private workletReady: Promise<void> | null = null

  private byteBuf: Uint8Array = new Uint8Array(0)
  private wavParsed = false
  private sampleRate = 24000
  private started = false
  private eosSent = false
  private aborted = false
  private finishWatch: ReturnType<typeof setInterval> | null = null
  private hasReceivedAudio = false
  private startCheck: ReturnType<typeof setInterval> | null = null

  playing = false
  hooks: PlayerHooks = {}

  /** هل وصل أي صوت فعلي في الدورة الحالية */
  get receivedAudio(): boolean {
    return this.hasReceivedAudio
  }

  private async ensureWorklet(): Promise<void> {
    if (this.workletReady) return this.workletReady
    this.workletReady = (async () => {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      this.ctx = new Ctx({ sampleRate: this.sampleRate }) as AudioContext
      const ctx = this.ctx as AudioContext
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
      this.gain = ctx.createGain()
      this.gain.gain.value = 1
      this.gain.connect(ctx.destination)
      if (ctx.audioWorklet) {
        await ctx.audioWorklet.addModule('/voice-worklet.js')
        this.node = new AudioWorkletNode(ctx, 'aact-voice-player', { outputChannelCount: [1] })
        this.node.port.onmessage = (e) => {
          if (e.data.type === 'started') {
            this.playing = true
            this.hooks.onPlaybackStart?.()
          } else if (e.data.type === 'finished') {
            this.playing = false
            this.hooks.onPlaybackEnd?.()
          }
        }
        this.node.connect(this.gain)
      } else {
        // Fallback قديم — ScriptProcessor
        this.spNode = ctx.createScriptProcessor(4096, 1, 1)
        const ring = new Float32Array(ctx.sampleRate * 4)
        let w = 0, r = 0, buffered = 0, playing = false
        ;(this as any)._sp = { ring, getW: () => w, setW: (v: number) => (w = v), getR: () => r, setR: (v: number) => (r = v), getB: () => buffered, setB: (v: number) => (buffered = v), getPlaying: () => playing, setPlaying: (v: boolean) => { const was = playing; playing = v; if (v && !was) this.hooks.onPlaybackStart?.(); if (!v && was) { this.hooks.onPlaybackEnd?.() } } }
        this.spNode.onaudioprocess = (ev) => {
          const out = ev.outputBuffer.getChannelData(0)
          for (let i = 0; i < out.length; i++) {
            if (buffered > 0) {
              out[i] = ring[r]
              r = (r + 1) % ring.length
              buffered--
            } else out[i] = 0
          }
          if (this.eosSent && buffered === 0 && playing) {
            playing = false
            this.hooks.onPlaybackEnd?.()
          }
        }
        this.spNode.connect(this.gain)
      }
    })()
    return this.workletReady
  }

  private pushSamples(f32: Float32Array) {
    if (this.node) {
      this.node.port.postMessage({ type: 'push', samples: f32 }, [f32.buffer])
    } else if (this.spNode) {
      const st = (this as any)._sp
      const ring = st.ring
      for (let i = 0; i < f32.length; i++) {
        if (st.getB() >= ring.length) break
        ring[st.getW()] = f32[i]
        st.setW((st.getW() + 1) % ring.length)
        st.setB(st.getB() + 1)
      }
    }
  }

  private startPlaybackWhenBuffered() {
    if (this.startCheck) return
    const startedAt = performance.now()
    this.startCheck = setInterval(() => {
      if (this.aborted) { this.clearStartCheck(); return }
      const bufferedSamples = this.bufferedSamples()
      const enough = bufferedSamples >= this.sampleRate * 0.2 // 200ms
      const waitedLong = performance.now() - startedAt > 700 // لا تنتظر الأبد
      if ((enough && this.hasReceivedAudio) || (waitedLong && this.hasReceivedAudio)) {
        this.clearStartCheck()
        if (this.node) this.node.port.postMessage({ type: 'start' })
        else if (this.spNode) (this as any)._sp.setPlaying(true)
      }
    }, 40)
  }

  private clearStartCheck() {
    if (this.startCheck) { clearInterval(this.startCheck); this.startCheck = null }
  }

  private bufferedSamples(): number {
    if (this.node) {
      // لا نستطيع قراءة حالة الـworklet مباشرة — نتابع بالبايتات المستلمة محلياً
      return this.receivedSamples - this.playedEstimate
    }
    return (this as any)._sp?.getB() || 0
  }

  private receivedSamples = 0
  private playedEstimate = 0

  /** تشغيل مقطع TTS متدفق من الرابط. يعيد وعد ينتهي بانتهاء صوت هذا المقطع طبيعياً */
  async playTtsStream(url: string, fetchOpts: RequestInit): Promise<void> {
    this.reset()
    const res = await fetch(url, fetchOpts)
    if (!res.ok || !res.body) throw new Error('TTS_STREAM_HTTP_' + res.status)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let sseBuf = ''

    await this.ensureWorklet()
    if (this.ctx && Math.abs(this.ctx.sampleRate - this.sampleRate) > 1) {
      // sampleRate مختلف عن المتوقع — أنشئ سياقاً مطابقاً
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      try { await this.ctx.close() } catch {}
      const ctx2: AudioContext = new Ctx({ sampleRate: this.sampleRate })
      this.ctx = ctx2
      this.gain = ctx2.createGain()
      this.gain.connect(ctx2.destination)
      await ctx2.audioWorklet.addModule('/voice-worklet.js')
      this.node = new AudioWorkletNode(ctx2, 'aact-voice-player', { outputChannelCount: [1] })
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'started') { this.playing = true; this.hooks.onPlaybackStart?.() }
        else if (e.data.type === 'finished') { this.playing = false; this.hooks.onPlaybackEnd?.() }
      }
      this.node.connect(this.gain)
    }

    const donePromise = new Promise<void>((resolve) => {
      const prevEnd = this.hooks.onPlaybackEnd
      this.hooks.onPlaybackEnd = () => {
        prevEnd?.()
        resolve()
      }
    })

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuf += decoder.decode(value, { stream: true })
      const lines = sseBuf.split('\n')
      sseBuf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          if (json.type === 'audio' && json.b64) {
            if (!this.hasReceivedAudio) {
              this.hasReceivedAudio = true
              this.hooks.onFirstChunk?.()
            }
            this.feedWavBytes(base64ToBytes(json.b64))
          } else if (json.type === 'error') {
            throw new Error(json.error || 'TTS_ERROR')
          }
        } catch (e: any) {
          if (e?.message && e.message !== 'Unexpected end of JSON input' && !e.message.includes('JSON')) throw e
        }
      }
    }
    // نهاية البث — أبلّغ الworklet بـeos (يصرّح المتبقي ثم finished)
    this.eosSent = true
    if (this.node) this.node.port.postMessage({ type: 'eos' })
    // fallback SP: الاكتمال يُرصد في onaudioprocess أعلاه
    await donePromise
  }

  /** فك بايتات WAV المتدفقة: ترويسة أول مرة ثم PCM متواصل */
  private feedWavBytes(bytes: Uint8Array) {
    if (!this.wavParsed) {
      // اجمع حتى نعرف موقع data chunk
      this.byteBuf = concatBytes(this.byteBuf, bytes)
      const headerView = new DataView(this.byteBuf.buffer, this.byteBuf.byteOffset, this.byteBuf.byteLength)
      if (this.byteBuf.length < 44) return
      if (ascii(headerView, 0, 4) !== 'RIFF' || ascii(headerView, 8, 4) !== 'WAVE') {
        this.aborted = true
        throw new Error('NOT_WAV')
      }
      // امشِ على الـchunks
      let pos = 12
      let dataStart = -1
      while (pos + 8 <= this.byteBuf.length) {
        const id = ascii(headerView, pos, 4)
        const size = headerView.getUint32(pos + 4, true)
        if (id === 'fmt ') {
          const channels = headerView.getUint16(pos + 8, true)
          this.sampleRate = headerView.getUint32(pos + 12, true)
          const bits = headerView.getUint16(pos + 22, true)
          void channels
          void bits
        }
        if (id === 'data') { dataStart = pos + 8; break }
        pos += 8 + size + (size % 2)
      }
      if (dataStart < 0) return // الترويسة لم تكتمل
      const pcm = this.byteBuf.subarray(dataStart)
      this.wavParsed = true
      this.byteBuf = new Uint8Array(0)
      if (pcm.length) this.pushPcm(pcm)
      return
    }
    this.pushPcm(bytes)
  }

  private leftover = 0 // بايت معلق غير مكتمل (16-bit = 2 بايتات)

  private pushPcm(bytes: Uint8Array) {
    // ادمج الباقي السابق إن وجد
    let all: Uint8Array
    if (this.leftover > 0 && this.byteBuf.length) {
      all = concatBytes(this.byteBuf, bytes)
      this.byteBuf = new Uint8Array(0)
    } else {
      all = bytes
    }
    const usable = all.length - (all.length % 2)
    this.leftover = all.length % 2
    if (this.leftover > 0) {
      this.byteBuf = all.slice(usable)
    }
    const int16 = new Int16Array(all.buffer, all.byteOffset, usable / 2)
    const f32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
    this.receivedSamples += f32.length
    this.pushSamples(f32)
  }

  /** حقن صمت (وقفة prosody) بالمللي ثانية داخل البث */
  pushSilence(ms: number) {
    const n = Math.round((this.sampleRate * ms) / 1000)
    this.receivedSamples += n
    this.pushSamples(new Float32Array(n))
  }

  /** إيقاف فوري مع خفوت — للمقاطعة (barge-in) */
  stop(fadeMs = 30) {
    this.aborted = true
    this.clearStartCheck()
    if (this.finishWatch) { clearInterval(this.finishWatch); this.finishWatch = null }
    try {
      if (this.gain && this.ctx) {
        const now = this.ctx.currentTime
        this.gain.gain.cancelScheduledValues(now)
        this.gain.gain.setValueAtTime(this.gain.gain.value, now)
        this.gain.gain.linearRampToValueAtTime(0.0001, now + fadeMs / 1000)
      }
      if (this.node) {
        this.node.port.postMessage({ type: 'stop' })
        setTimeout(() => { try { this.node?.disconnect() } catch {} }, fadeMs + 10)
        this.node = null
      }
      if (this.spNode) {
        (this as any)._sp?.setPlaying(false)
        setTimeout(() => { try { this.spNode?.disconnect() } catch {} }, fadeMs + 10)
        this.spNode = null
      }
      this.workletReady = null
    } catch {}
    this.playing = false
  }

  private reset() {
    this.byteBuf = new Uint8Array(0)
    this.wavParsed = false
    this.started = false
    this.eosSent = false
    this.aborted = false
    this.hasReceivedAudio = false
    this.receivedSamples = 0
    this.playedEstimate = 0
    this.leftover = 0
    void this.started
    void this.finishWatch
  }

  /** إغلاق كامل عند مغادرة الوضع الصوتي */
  destroy() {
    this.stop(10)
    setTimeout(() => { try { this.ctx?.close() } catch {} }, 150)
    this.ctx = null
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function ascii(view: DataView, start: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(start + i))
  return s
}
