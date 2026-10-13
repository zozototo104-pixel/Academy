import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getZAI } from '@/lib/ai'

type TranscribeAudioOptions = {
  mimeType?: string | null
  languageCode?: string | null
  allowZaiFallback?: boolean | null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function isOggOrOpusMime(mimeType?: string | null) {
  const mime = normalizeAudioMimeType(mimeType)
  return mime.includes('ogg') || mime.includes('opus')
}

function ffmpegBinary() {
  return String(process.env.FFMPEG_BINARY || 'ffmpeg').trim() || 'ffmpeg'
}

async function transcodeOggOpusToWavBase64(cleanBase64: string, timeoutMs = 15_000) {
  const id = randomUUID()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aact-whatsapp-voice-'))
  const input = path.join(dir, `${id}.ogg`)
  const output = path.join(dir, `${id}.wav`)
  await fs.writeFile(input, Buffer.from(cleanBase64, 'base64'))
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegBinary(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', output], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`WHATSAPP_VOICE_TRANSCODE_TIMEOUT_${timeoutMs}ms`))
      }, timeoutMs)
      child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, 1000) })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`WHATSAPP_VOICE_TRANSCODE_FAILED: ${String(error.message || error).slice(0, 240)}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`WHATSAPP_VOICE_TRANSCODE_FAILED: ffmpeg exited ${code}${stderr ? ` — ${stderr.slice(0, 240)}` : ''}`))
      })
    })
    const wav = await fs.readFile(output)
    return { clean: wav.toString('base64'), mimeType: 'audio/wav', converted: true }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function prepareAudioForAsr(cleanBase64: string, mimeType: string) {
  if (!isOggOrOpusMime(mimeType)) return { clean: cleanBase64, mimeType, converted: false }
  return transcodeOggOpusToWavBase64(cleanBase64)
}

function shouldWaitForGeminiFileState(state: string) {
  const normalized = String(state || '').toUpperCase()
  return normalized.includes('PROCESSING') || normalized.includes('PENDING') || normalized.includes('UNSPECIFIED')
}

async function waitForGeminiFileReady(ai: GoogleGenAI, uploadedFile: any) {
  const name = uploadedFile?.name
  if (!name) return uploadedFile

  let file = uploadedFile
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = String(file?.state || '').toUpperCase()
    if (!state || state.includes('ACTIVE') || state.includes('READY')) return file
    if (state.includes('FAILED') || state.includes('ERROR')) {
      throw new Error(`Gemini ASR uploaded file failed to become active: ${state}`)
    }
    if (!shouldWaitForGeminiFileState(state)) return file
    await sleep(400 + attempt * 250)
    file = await ai.files.get({ name } as any).catch(() => file)
  }
  console.warn('Gemini ASR uploaded file still not active after wait:', String(file?.state || 'unknown').slice(0, 80))
  return file
}

function previewGeminiParts(parts: any[]) {
  try {
    return JSON.stringify(parts).slice(0, 500)
  } catch {
    return String(parts).slice(0, 500)
  }
}

function extractGeminiTranscript(response: any) {
  const parts = Array.isArray(response?.candidates?.[0]?.content?.parts)
    ? response.candidates[0].content.parts
    : []

  const fromTranscription = parts
    .map((part: any) => part?.audioTranscription?.text ?? part?.audioTranscription?.transcript ?? '')
    .filter((text: unknown) => typeof text === 'string' && text.trim())
    .join(' ')
    .trim()

  if (fromTranscription) return fromTranscription

  const fromText = parts
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join(' ')
    .trim()

  if (!fromText) {
    console.warn('Gemini ASR returned empty transcript parts:', previewGeminiParts(parts))
  }

  return fromText
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

    uploadedFile = await waitForGeminiFileReady(ai, uploadedFile)

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

    return extractGeminiTranscript(response)
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
  const { clean, mimeType } = cleanBase64AndMime(audioBase64, options.mimeType)
  if (!clean) return ''

  const skipZaiFallback = options.allowZaiFallback === false || isOggOrOpusMime(mimeType)

  try {
    const geminiText = await transcribeWithGemini(clean, { ...options, mimeType })
    if (geminiText !== null) return geminiText
  } catch (error) {
    const reason = String((error as any)?.message || error).slice(0, 300)
    if (skipZaiFallback) {
      console.warn('Gemini ASR failed; ZAI fallback disabled for this audio:', JSON.stringify({ mimeType, reason }).slice(0, 500))
      throw error
    }
    console.warn('Gemini ASR failed, falling back to ZAI:', reason)
  }

  if (skipZaiFallback) {
    throw new Error(`Gemini ASR unavailable for ${mimeType}; ZAI fallback disabled.`)
  }

  return transcribeWithZai(clean)
}
