import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai'
import { getZAI } from '@/lib/ai'

type TranscribeAudioOptions = {
  mimeType?: string | null
  languageCode?: string | null
}

function cleanBase64AndMime(audioBase64: string, mimeType?: string | null) {
  const raw = String(audioBase64 || '').trim()
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/i)
  const detectedMime = dataUrlMatch?.[1] || mimeType || ''
  const clean = dataUrlMatch?.[2] || raw
  return { clean, mimeType: normalizeAudioMimeType(detectedMime) }
}

function normalizeAudioMimeType(value?: string | null) {
  const raw = String(value || '').trim().toLowerCase()
  const base = raw.split(';')[0]?.trim() || ''
  if (base) return base
  return 'audio/ogg'
}

function geminiApiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
}

function audioExtensionForMime(mimeType: string) {
  const mime = normalizeAudioMimeType(mimeType)
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('opus')) return 'opus'
  if (mime.includes('ogg')) return 'ogg'
  return 'audio'
}

async function transcribeWithGemini(audioBase64: string, options: TranscribeAudioOptions = {}) {
  const apiKey = geminiApiKey()
  if (!apiKey) return null

  const { clean, mimeType } = cleanBase64AndMime(audioBase64, options.mimeType)
  if (!clean) return ''

  const ai = new GoogleGenAI({ apiKey })
  const audioBuffer = Buffer.from(clean, 'base64')
  const audioBlob = new Blob([audioBuffer], { type: mimeType })
  let uploadedFile: any = null

  try {
    uploadedFile = await ai.files.upload({
      file: audioBlob as any,
      config: {
        mimeType,
        displayName: `whatsapp-voice-${Date.now()}.${audioExtensionForMime(mimeType)}`,
      },
    } as any)

    const fileUri = uploadedFile?.uri
    const fileMimeType = uploadedFile?.mimeType || mimeType
    if (!fileUri) throw new Error('Gemini ASR upload did not return a file URI.')

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_ASR_MODEL || 'gemini-3.5-transcribe',
      contents: [createUserContent([createPartFromUri(fileUri, fileMimeType)])],
      config: options.languageCode
        ? {
            audioTranscriptionConfig: {
              languageCodes: [options.languageCode],
            },
          }
        : undefined,
    } as any)

    return String((response as any)?.text || '').trim()
  } finally {
    const uploadedName = uploadedFile?.name
    if (uploadedName) {
      ai.files.delete({ name: uploadedName }).catch((error: any) => {
        console.warn('Gemini ASR temp file delete failed:', String(error).slice(0, 240))
      })
    }
  }
}

async function transcribeWithZai(audioBase64: string) {
  const { clean } = cleanBase64AndMime(audioBase64)
  if (!clean) return ''
  const zai = await getZAI()
  const response = await zai.audio.asr.create({ file_base64: clean })
  return String(response?.text || '').trim()
}

export async function transcribeAudioBase64(audioBase64: string, options: TranscribeAudioOptions = {}) {
  const { clean } = cleanBase64AndMime(audioBase64, options.mimeType)
  if (!clean) return ''

  try {
    const geminiText = await transcribeWithGemini(clean, options)
    if (geminiText !== null) return geminiText
  } catch (error) {
    console.warn('Gemini ASR failed, falling back to ZAI:', String(error).slice(0, 300))
  }

  return transcribeWithZai(clean)
}
