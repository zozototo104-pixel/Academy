import { readFileSync } from 'fs'
import { join } from 'path'

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const textAi = file('src/lib/text-ai.ts')
const ocr = file('src/lib/ocr.ts')
const bookReader = file('src/lib/book-reader.ts')
const gemini = file('src/lib/gemini.ts')

assert(textAi.includes('export interface TextAiAttachment'), 'TextAiCallOpts must define attachment payloads')
assert(textAi.includes('attachments?: TextAiAttachment[]'), 'TextAiCallOpts must accept optional attachments')
assert(textAi.includes('MAX_VISION_ATTACHMENT_BYTES = 15 * 1024 * 1024'), 'vision attachments must be limited to 15MB')
assert(textAi.includes('VISION_ATTEMPT_TIMEOUT_MS = 25_000'), 'vision provider attempts must timeout after 25 seconds')

assert(textAi.includes('modelSupportsVisionAttachment') && textAi.includes('capability?.vision === true'), 'router must select only vision-capable models for attachments')
assert(textAi.includes("providerSupportsVisionAttachments(provider)"), 'router must skip providers that do not support vision attachments')
assert(textAi.includes("attachment.mimeType === 'application/pdf'"), 'router must handle PDF attachments separately from images')

assert(textAi.includes('inlineData: { mimeType: attachment.mimeType, data: attachment.base64 }'), 'Gemini must receive attachments as inlineData')
assert(textAi.includes("type: 'input_image'") && textAi.includes("type: 'input_file'"), 'OpenAI Responses must send images and files using the proper content types')
assert(textAi.includes("type: 'image_url'") && textAi.includes("type: 'file'"), 'OpenAI-compatible providers must send image_url/file payloads')
assert(textAi.includes("type: 'image'") && textAi.includes("type: 'document'"), 'Anthropic must send image/document content blocks')
assert(textAi.includes('createVision') && textAi.includes("provider === 'ZAI' && hasVisionAttachments(opts)"), 'ZAI vision calls must use createVision')

assert(textAi.includes('candidateKeys(provider, s)') && textAi.includes('for (const key of candidateKeys(provider, s))'), 'router must keep rotating through provider keys, including Gemini DB/env keys')
assert(textAi.includes('OPENAI_COMPAT') && textAi.includes('s.openaiCompatTier === \'PAID\''), 'paid OpenAI-compatible provider must remain last-resort governed by existing policy')
assert(textAi.includes('recordAttempt(attempt)') && textAi.includes('logRouterSummary(attempts'), 'router must keep audit diagnostics for successful and failed providers')
const recordAttemptBody = textAi.slice(textAi.indexOf('function recordAttempt'), textAi.indexOf('async function callGemini'))
assert(!recordAttemptBody.includes('attachments') && !recordAttemptBody.includes('base64'), 'router diagnostics must not log file attachment content')
assert(textAi.includes('errors.push(`${provider}/${model}/key#${keyIndex}: ${msg}`)'), 'router must record failed providers and reasons without file content')

assert(ocr.includes("import { textAiCompleteJson } from '@/lib/text-ai'") && !ocr.includes('geminiVisionJson') && !ocr.includes('getZAI()'), 'ocr.ts must route visual documents through text AI router only')
assert(ocr.includes("purpose: 'VISION'") && ocr.includes('attachments: [{ mimeType: normalized.mimeType, base64: normalized.buffer.toString'), 'ocr.ts must pass normalized visual attachments to the router')
assert(ocr.includes('لم تُقرأ الصورة آلياً') && ocr.includes('NEEDS_CLARIFICATION') === false, 'ocr.ts must keep the safe unreadable result instead of fabricating approval')

assert(bookReader.includes("import { textAiCompleteJson } from '@/lib/text-ai'") && !bookReader.includes('geminiVisionJson'), 'book-reader.ts must route scanned PDF OCR through text AI router')
assert(bookReader.includes("purpose: 'VISION'") && bookReader.includes("attachments: [{ mimeType: 'application/pdf'"), 'book-reader.ts must pass scanned PDF subsets to the router')

assert(!gemini.includes('gemini-1.5-flash') && !gemini.includes('gemini-1.5-pro'), 'deprecated hard-coded Gemini 1.5 vision fallbacks must be removed')

assert(textAi.includes('TEXT_AI_ROUTER_NO_VISION_PROVIDER') && textAi.includes('TEXT_AI_ROUTER_FAILED'), 'all-provider failure must surface as router failure so callers return the safe unreadable/clarification path')
assert(textAi.includes('if (isNoBalanceLike(e))') && textAi.includes('markPersistentNoBalance'), 'no-balance handling must remain in router cooldown policy')
assert(textAi.includes('if (isDeadModelLike(e))') && textAi.includes('markPersistentModelDead'), 'dead-model handling must remain in router policy')

console.log('✓ vision router wiring checks passed')
