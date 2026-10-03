import { getZAI } from '@/lib/ai'

export async function transcribeAudioBase64(audioBase64: string) {
  const clean = String(audioBase64 || '').trim()
  if (!clean) return ''
  const zai = await getZAI()
  const response = await zai.audio.asr.create({ file_base64: clean })
  return String(response?.text || '').trim()
}
