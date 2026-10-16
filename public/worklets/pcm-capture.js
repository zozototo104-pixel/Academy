class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.targetRate = 16000
  }

  downsampleTo16k(input) {
    const inputRate = sampleRate || 48000
    if (inputRate === this.targetRate) {
      const out = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff
      return out
    }
    const ratio = inputRate / this.targetRate
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

  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    let peak = 0
    for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]))
    const pcm = this.downsampleTo16k(input)
    const bytes = new Uint8Array(pcm.buffer)
    this.port.postMessage({ level: Math.min(1, peak * 6), peak, pcm: bytes.buffer }, [bytes.buffer])
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
