/**
 * aact-voice-player — AudioWorklet لمشغّل البث الصوتي المتواصل.
 * يستقبل Float32 PCM عبر port ويشغّله بلا فجوات من ring buffer.
 * الرسائل:
 *   main→worklet: {type:'push', samples} | {type:'start'} | {type:'stop'} | {type:'eos'}
 *   worklet→main: {type:'started'} | {type:'finished'} (نزول طبيعي بعد eos)
 */
class VoicePlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.capacity = 48000 * 4 // 4 ثوانٍ ring
    this.ring = new Float32Array(this.capacity)
    this.writePos = 0
    this.readPos = 0
    this.buffered = 0
    this.playing = false
    this.eos = false
    this.port.onmessage = (e) => {
      const d = e.data
      if (d.type === 'push') {
        const s = d.samples
        for (let i = 0; i < s.length; i++) {
          if (this.buffered >= this.capacity) break // تجاوز السعة — تجاهل الأقدم
          this.ring[this.writePos] = s[i]
          this.writePos = (this.writePos + 1) % this.capacity
          this.buffered++
        }
      } else if (d.type === 'start') {
        if (!this.playing) {
          this.playing = true
          this.port.postMessage({ type: 'started' })
        }
      } else if (d.type === 'stop') {
        this.playing = false
        this.eos = false
        this.buffered = 0
        this.writePos = 0
        this.readPos = 0
      } else if (d.type === 'eos') {
        this.eos = true
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    if (!this.playing) {
      out.fill(0)
      return true
    }
    const n = out.length
    let drained = 0
    for (let i = 0; i < n; i++) {
      if (this.buffered > 0) {
        out[i] = this.ring[this.readPos]
        this.readPos = (this.readPos + 1) % this.capacity
        this.buffered--
        drained++
      } else {
        out[i] = 0 // underrun → صمت بلا نقرات
      }
    }
    if (this.eos && this.buffered === 0 && drained > 0) {
      this.playing = false
      this.eos = false
      this.port.postMessage({ type: 'finished' })
    }
    return true
  }
}

registerProcessor('aact-voice-player', VoicePlayerProcessor)
