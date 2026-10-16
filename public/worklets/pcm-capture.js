class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
    this.inputChunkSize = 1600
    this.inputBuffer = new Float32Array(0)
    this.downsampleCarry = new Float32Array(0)
  }

  concatFloat(a, b) {
    if (!a || a.length === 0) return new Float32Array(b)
    const out = new Float32Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  toPcm16(input) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff
    return out
  }

  downsampleChunk(input) {
    const inputRate = sampleRate || 48000
    if (inputRate === this.targetRate) return this.toPcm16(input)
    const ratio = inputRate / this.targetRate
    const combined = this.concatFloat(this.downsampleCarry, input)
    const len = Math.floor(combined.length / ratio)
    const out = new Int16Array(len)
    for (let i = 0; i < len; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(combined.length, Math.floor((i + 1) * ratio))
      let sum = 0
      for (let j = start; j < end; j++) sum += combined[j]
      const v = sum / Math.max(1, end - start)
      out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
    }
    const consumed = Math.floor(len * ratio)
    this.downsampleCarry = combined.slice(consumed)
    return out
  }

  postPcmChunk(rawChunk) {
    let peak = 0
    for (let i = 0; i < rawChunk.length; i++) peak = Math.max(peak, Math.abs(rawChunk[i]))
    const pcm = this.downsampleChunk(rawChunk)
    if (!pcm.length) return
    const bytes = new Uint8Array(pcm.buffer)
    this.port.postMessage({ level: Math.min(1, peak * 6), peak, sampleCount: pcm.length, pcm: bytes.buffer }, [bytes.buffer])
  }

  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    this.inputBuffer = this.concatFloat(this.inputBuffer, input)
    while (this.inputBuffer.length >= this.inputChunkSize) {
      const chunk = this.inputBuffer.slice(0, this.inputChunkSize)
      this.inputBuffer = this.inputBuffer.slice(this.inputChunkSize)
      this.postPcmChunk(chunk)
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
