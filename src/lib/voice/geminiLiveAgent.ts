import type { VoiceState } from './voiceStateMachine'

export interface AgentCallbacks {
  onState?: (s: VoiceState) => void
  onLevel?: (level: number) => void
  onUserCaption?: (text: string) => void
  onAiCaption?: (fullTextSoFar: string) => void
  onTimings?: (rows: { event: string; atMs: number }[]) => void
  onTurnComplete?: (turn: { userText: string; aiText: string; messageId?: string }) => void
  onInterrupted?: (info: { spokenPartial: string }) => void
  onError?: (msg: string) => void
}

type LiveSessionPayload = {
  wsUrl: string
  setup: unknown
  model: string
  voice: string
  error?: string
  details?: string
}

function getToken(): string {
  try { return localStorage.getItem('aact_token') || '' } catch { return '' }
}

function friendlyClientError(e: unknown): string {
  const raw = String((e as any)?.message || e || '').trim()
  if (!raw) return 'تعذر بدء المحادثة الصوتية.'
  if (/يجب تسجيل الدخول|UNAUTHORIZED|401/i.test(raw)) return 'يجب تسجيل الدخول أولاً قبل بدء محادثة Gemini Live.'
  if (/NotAllowedError|Permission denied|permission|denied|رفض|السماح/i.test(raw)) {
    return 'المتصفح رفض المايكروفون. افتح إعدادات الموقع في Safari/Chrome واسمح بالمايكروفون ثم أعد المحاولة.'
  }
  if (/NotFoundError|DevicesNotFoundError|no microphone|الميكروفون غير موجود/i.test(raw)) {
    return 'لم يتم العثور على مايكروفون في هذا الجهاز.'
  }
  if (/NotReadableError|TrackStartError|device is busy/i.test(raw)) {
    return 'الميكروفون مستخدم من تطبيق آخر أو غير متاح حالياً. أغلق أي مكالمة أخرى ثم جرّب مجدداً.'
  }
  if (/mediaDevices|getUserMedia|secure context|HTTPS/i.test(raw)) {
    return 'هذا المتصفح لا يسمح بالمايكروفون هنا. افتح الموقع عبر HTTPS ومن Safari/Chrome مباشرة.'
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw)) {
    return 'انتهت حصة Gemini Live مؤقتاً. فعّل Billing أو انتظر إعادة ضبط الحصة.'
  }
  if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED|403/i.test(raw)) {
    return 'مفتاح Gemini غير صالح أو لا يملك صلاحية Gemini Live.'
  }
  return raw.slice(0, 260)
}

function b64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64ToInt16(b64: string): Int16Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === 16000) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff
    return out
  }
  const ratio = inputRate / 16000
  const len = Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    const v = sum / Math.max(1, end - start)
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
  }
  return out
}

class Pcm24Player {
  private ctx: AudioContext | null = null
  private nextTime = 0

  async play(b64: string) {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) throw new Error('AudioContext غير مدعوم في هذا المتصفح')
    if (!this.ctx) this.ctx = new Ctx({ sampleRate: 24000 }) as AudioContext
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    const pcm = b64ToInt16(b64)
    const buf = this.ctx.createBuffer(1, pcm.length, 24000)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    if (this.nextTime < now + 0.03) this.nextTime = now + 0.03
    src.start(this.nextTime)
    this.nextTime += buf.duration
  }

  stop() {
    this.nextTime = 0
    try { this.ctx?.close() } catch {}
    this.ctx = null
  }
}

export class GeminiLiveAgent {
  private cb: AgentCallbacks
  private ws: WebSocket | null = null
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private player = new Pcm24Player()
  private muted = false
  private running = false
  private setupReady = false
  private startedAt = 0
  private timings: { event: string; atMs: number }[] = []
  private userText = ''
  private aiText = ''
  private model = ''

  constructor(callbacks: AgentCallbacks = {}) {
    this.cb = callbacks
  }

  private state(s: VoiceState) { this.cb.onState?.(s) }
  private mark(event: string) {
    const atMs = Math.round(performance.now() - this.startedAt)
    this.timings.push({ event, atMs })
    this.cb.onTimings?.(this.timings.slice(-12))
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.setupReady = false
    this.startedAt = performance.now()
    this.state('THINKING')

    try {
      // مهم جداً في iPhone/Safari: طلب المايكروفون يجب أن يحدث مباشرة بعد ضغطة المستخدم
      // قبل أي fetch أو WebSocket حتى لا يضيع user activation.
      await this.prepareMicrophone()
      this.mark('تم السماح بالمايكروفون')

      const session = await this.createLiveSession()
      this.model = session.model
      await this.openSocket(session)
    } catch (e) {
      this.stop()
      throw new Error(friendlyClientError(e))
    }
  }

  private async prepareMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia غير مدعوم أو الموقع غير مفتوح عبر HTTPS')
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })

    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) throw new Error('AudioContext غير مدعوم في هذا المتصفح')
    this.ctx = new Ctx() as AudioContext
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (e) => this.sendAudioFrame(e)
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination)
  }

  private async createLiveSession(): Promise<LiveSessionPayload> {
    this.mark('طلب جلسة Gemini Live')
    const sessionRes = await fetch('/api/ai/gemini-live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: JSON.stringify({}),
    })
    const session: LiveSessionPayload = await sessionRes.json().catch(() => ({
      error: 'تعذر قراءة رد Gemini Live من الخادم',
      wsUrl: '',
      setup: null,
      model: '',
      voice: '',
    }))
    if (!sessionRes.ok || !session.wsUrl) {
      throw new Error(session.error || `فشل إنشاء جلسة Gemini Live HTTP ${sessionRes.status}`)
    }
    return session
  }

  private openSocket(session: LiveSessionPayload): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (msg: string) => {
        if (!settled) {
          settled = true
          reject(new Error(msg))
        } else {
          this.cb.onError?.(friendlyClientError(msg))
        }
      }

      const timer = window.setTimeout(() => {
        fail('لم يكتمل إعداد اتصال Gemini Live خلال المهلة المحددة')
      }, 15_000)

      this.ws = new WebSocket(session.wsUrl)
      this.ws.onopen = () => {
        this.mark('فتح WebSocket')
        this.ws?.send(JSON.stringify(session.setup))
      }
      this.ws.onerror = () => fail('تعذر الاتصال بـ Gemini Live. تحقق من المفتاح والحصة وBilling.')
      this.ws.onclose = () => {
        window.clearTimeout(timer)
        if (!this.setupReady) fail('انقطع اتصال Gemini Live قبل اكتمال الإعداد')
        if (this.running) this.state('IDLE')
        this.running = false
      }
      this.ws.onmessage = (ev) => {
        const completed = this.handleMessage(ev.data)
        if (completed && !settled) {
          settled = true
          window.clearTimeout(timer)
          this.setupReady = true
          this.state('LISTENING')
          this.mark('اكتمل إعداد Gemini Live')
          resolve()
        }
      }
    })
  }

  private sendAudioFrame(e: AudioProcessingEvent) {
    if (!this.running || !this.setupReady || this.muted || this.ws?.readyState !== WebSocket.OPEN || !this.ctx) return
    const input = e.inputBuffer.getChannelData(0)
    let peak = 0
    for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]))
    this.cb.onLevel?.(Math.min(1, peak * 6))
    this.state(peak > 0.018 ? 'USER_SPEAKING' : 'LISTENING')
    const pcm16 = downsampleTo16k(input, this.ctx.sampleRate || 48000)
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=16000', data: b64FromInt16(pcm16) },
      },
    }))
  }

  private handleMessage(raw: any): boolean {
    let msg: any
    try { msg = JSON.parse(String(raw)) } catch { return false }
    if (msg.error) {
      this.cb.onError?.(friendlyClientError(msg.error.message || 'خطأ من Gemini Live'))
      return false
    }
    if (msg.setupComplete) return true

    const sc = msg.serverContent || msg
    if (sc.interrupted) {
      this.interrupt()
      return false
    }

    const inputText = sc.inputTranscription?.text || sc.interimInputTranscription?.text || sc.inputAudioTranscription?.text || sc.inputTranscription?.transcript
    if (inputText) {
      this.userText = inputText
      this.cb.onUserCaption?.(this.userText)
    }
    const outputText = sc.outputTranscription?.text || sc.outputAudioTranscription?.text || sc.outputTranscription?.transcript
    if (outputText) {
      this.aiText += outputText
      this.cb.onAiCaption?.(this.aiText)
    }
    const parts = sc.modelTurn?.parts || sc.content?.parts || []
    for (const part of parts) {
      const b64 = part?.inlineData?.data
      if (b64) {
        this.state('AI_SPEAKING')
        this.mark('استقبال صوت Gemini PCM 24k')
        void this.player.play(b64).catch((e) => this.cb.onError?.(friendlyClientError(e)))
      }
    }
    if (sc.turnComplete || sc.generationComplete) {
      const userText = this.userText.trim()
      const aiText = this.aiText.trim()
      if (userText || aiText) {
        this.cb.onTurnComplete?.({ userText, aiText })
        void this.logTurn(userText, aiText)
      }
      this.userText = ''
      this.aiText = ''
      this.state('LISTENING')
    }
    return false
  }

  private async logTurn(userText: string, aiText: string) {
    try {
      await fetch('/api/ai/gemini-live/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: JSON.stringify({ userText, aiText, model: this.model }),
      })
    } catch {}
  }

  interrupt() {
    this.player.stop()
    this.cb.onInterrupted?.({ spokenPartial: this.aiText })
    this.state('LISTENING')
  }

  setMuted(v: boolean) {
    this.muted = v
    this.state(v ? 'IDLE' : 'LISTENING')
  }

  stop() {
    this.running = false
    this.setupReady = false
    this.player.stop()
    try { this.processor?.disconnect() } catch {}
    try { this.source?.disconnect() } catch {}
    try { this.ctx?.close() } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()) } catch {}
    try { this.ws?.close() } catch {}
    this.ws = null
    this.stream = null
    this.ctx = null
    this.processor = null
    this.source = null
    this.state('IDLE')
  }
}
