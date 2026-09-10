import { extractDocumentText, normalizeExtractedText } from '@/lib/document-extract'
import { ensureGeminiKey, geminiVisionJson } from '@/lib/gemini'

// ===== قراءة محتوى الكتب للامتحانات =====
// لا نعتمد على textContent فقط. إذا كان النص غير مستخرج، نحاول قراءة الملف المخزن، ثم الرابط،
// ثم Gemini Document/Vision للـ PDF أو الصور. لا نولّد امتحاناً من رابط/وصف فقط لأن ذلك ينتج أسئلة ركيكة لا تمثل الكتاب.

const MAX_FETCH_BYTES = 12 * 1024 * 1024
// نحتاج للامتحانات الجامعية محتوى واسعاً من الكتاب، لا أول صفحات فقط.
// لا يُرسل كل هذا للنموذج دفعة واحدة؛ books-ai.ts يبني منه ملخصاً موزعاً ومقاطع مختارة.
const MAX_BOOK_CONTEXT_CHARS = 180000
const MIN_STRONG_TEXT = 700
const MIN_USABLE_TEXT = 160

export interface RawBookForHydration {
  id?: string
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
  data?: string | null
  link?: string | null
  textContent?: string | null
}

export interface HydratedExamBook {
  id?: string
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  link?: string | null
  textContent: string
  sourceNote: string
  contentQuality: 'STORED_TEXT' | 'UPLOADED_FILE' | 'LINK_TEXT' | 'GEMINI_DOCUMENT' | 'METADATA_ONLY' | 'NO_CONTENT'
  shouldPersistText: boolean
}

function extOf(fileName?: string | null): string {
  const m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m?.[1] || ''
}

function inferMime(fileName?: string | null, fallback?: string | null): string {
  const mime = String(fallback || '').toLowerCase()
  if (mime && mime !== 'application/octet-stream') return mime
  const ext = extOf(fileName)
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (['xlsx', 'xlsm', 'xls'].includes(ext)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'txt' || ext === 'md') return 'text/plain'
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return mime || 'application/octet-stream'
}

function isVisualReadableByGemini(mimeType: string, fileName?: string | null): boolean {
  const mime = inferMime(fileName, mimeType)
  return mime.includes('pdf') || mime.startsWith('image/')
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function safeUrl(raw?: string | null): string | null {
  const u = String(raw || '').trim()
  if (!u) return null
  try {
    const parsed = new URL(u)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function looksLikeMetadataOnlyText(text: string): boolean {
  const n = normalizeExtractedText(text, 4000).toLowerCase()
  return (
    n.includes('رابط الكتاب أو مصدره') ||
    n.includes('ملاحظة قراءة المحتوى') ||
    n.includes('تنبيه للذكاء') ||
    n.includes('google.com/search') ||
    n.includes('tbm=bks')
  )
}

function parseGeminiBookJson(raw: string): { text: string; note: string } {
  const body = String(raw || '').trim()
  const json = body.match(/\{[\s\S]*\}/)?.[0]
  if (json) {
    try {
      const parsed = JSON.parse(json)
      return {
        text: normalizeExtractedText(String(parsed.textContent || parsed.summary || parsed.outline || ''), MAX_BOOK_CONTEXT_CHARS),
        note: normalizeExtractedText(String(parsed.note || parsed.qualityNote || 'تم تلخيص المستند بواسطة Gemini'), 500),
      }
    } catch {}
  }
  return { text: normalizeExtractedText(body, MAX_BOOK_CONTEXT_CHARS), note: 'استجابة Gemini غير JSON لكنها تحتوي نصاً قابلاً للاستخدام' }
}

async function readVisualDocumentWithGemini(buffer: Buffer, mimeType: string, book: RawBookForHydration): Promise<{ text: string; note: string }> {
  const hasKey = await ensureGeminiKey().catch(() => false)
  if (!hasKey) return { text: '', note: 'Gemini غير مفعّل لقراءة المستند بصرياً' }

  const prompt = `أنت خبير أكاديمي يقرأ كتاباً أو مرجعاً مرفقاً لبناء امتحان من محتواه.

بيانات الكتاب:
- العنوان: ${book.title}
- العنوان الإنجليزي: ${book.titleEn || '-'}
- المؤلف: ${book.author || '-'}
- الوصف: ${book.description || '-'}

المطلوب:
- اقرأ الملف المرفق قدر الإمكان.
- لا تعطِ ملخصاً عاماً قصيراً؛ ابنِ خريطة امتحانية شاملة من الملف: أبواب/فصول، مفاهيم مركزية، نظريات ونماذج، مصطلحات، خطوات ومنهجيات، حالات عملية، أخطاء شائعة، نقاط مقارنة، وأسئلة محتملة.
- اجعل الناتج طويلاً ومنظماً بما يكفي ليصبح قاعدة معرفة للامتحان والمشرف الذكي.
- إذا كان الملف كبيراً أو ممسوحاً ضوئياً ولا تستطيع قراءة كل الصفحات، لخّص ما ظهر فعلاً وحدد حدود القراءة في note ولا تقل "تعذر" إلا عند انعدام القراءة.
- لا تخترع نصاً حرفياً من الكتاب. عند نقص المحتوى، صرّح بذلك في note.

أجب JSON فقط:
{"textContent":"<ملخص معرفي طويل ومنظم من محتوى الكتاب يصلح لبناء الامتحان>","note":"<ما الذي تمت قراءته وما حدود القراءة>"}`

  try {
    const raw = await geminiVisionJson({
      prompt,
      images: [{ mimeType: inferMime(book.fileName, mimeType), dataBase64: buffer.toString('base64') }],
      temperature: 0.15,
      maxOutputTokens: 8192,
    })
    return parseGeminiBookJson(raw)
  } catch (e: any) {
    return { text: '', note: `تعذرت قراءة المستند عبر Gemini: ${String(e?.message || e).slice(0, 180)}` }
  }
}

async function readBufferContent(buffer: Buffer, mimeType: string, fileName: string | null | undefined, book: RawBookForHydration): Promise<{ text: string; note: string; quality: HydratedExamBook['contentQuality'] }> {
  const effectiveMime = inferMime(fileName, mimeType)
  const extracted = await extractDocumentText(buffer, effectiveMime, fileName, MAX_BOOK_CONTEXT_CHARS)
  if (extracted.text && extracted.text.length >= MIN_USABLE_TEXT) {
    return { text: extracted.text, note: extracted.note, quality: 'UPLOADED_FILE' }
  }

  if (isVisualReadableByGemini(effectiveMime, fileName)) {
    const visual = await readVisualDocumentWithGemini(buffer, effectiveMime, book)
    if (visual.text && visual.text.length >= MIN_USABLE_TEXT) {
      return { text: visual.text, note: visual.note, quality: 'GEMINI_DOCUMENT' }
    }
    return { text: '', note: visual.note || extracted.note, quality: 'GEMINI_DOCUMENT' }
  }

  return { text: '', note: extracted.note, quality: 'UPLOADED_FILE' }
}

async function fetchLinkContent(book: RawBookForHydration): Promise<{ text: string; note: string; quality: HydratedExamBook['contentQuality'] }> {
  const url = safeUrl(book.link)
  if (!url) return { text: '', note: 'لا يوجد رابط صالح للكتاب', quality: 'LINK_TEXT' }
  const parsedUrl = new URL(url)
  if (
    parsedUrl.hostname.includes('google.') &&
    (parsedUrl.pathname.includes('/search') || parsedUrl.searchParams.has('tbm') || parsedUrl.searchParams.has('q'))
  ) {
    return { text: '', note: 'هذا رابط بحث Google وليس رابط كتاب مباشر قابل للقراءة', quality: 'LINK_TEXT' }
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 18000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (AACT-Academy-Platform; book-content-reader)',
        Accept: 'application/pdf,text/html,text/plain,application/xhtml+xml,*/*;q=0.8',
      },
    })
    clearTimeout(timer)
    if (!res.ok) return { text: '', note: `رابط الكتاب أعاد حالة ${res.status}`, quality: 'LINK_TEXT' }

    const mime = inferMime(url, res.headers.get('content-type') || '')
    const length = Number(res.headers.get('content-length') || 0)
    if (length > MAX_FETCH_BYTES) return { text: '', note: 'حجم محتوى الرابط كبير جداً على القراءة المباشرة', quality: 'LINK_TEXT' }

    if (mime.includes('pdf') || mime.includes('wordprocessingml') || mime.includes('spreadsheetml') || mime.startsWith('image/')) {
      const arr = await res.arrayBuffer()
      if (arr.byteLength > MAX_FETCH_BYTES) return { text: '', note: 'حجم الملف على الرابط يتجاوز الحد المسموح للقراءة المباشرة', quality: 'LINK_TEXT' }
      const byBuffer = await readBufferContent(Buffer.from(arr), mime, url, { ...book, fileName: book.fileName || url, mimeType: mime })
      return { ...byBuffer, quality: byBuffer.quality === 'GEMINI_DOCUMENT' ? 'GEMINI_DOCUMENT' : 'LINK_TEXT' }
    }

    const html = await res.text()
    const text = normalizeExtractedText(stripHtml(html), MAX_BOOK_CONTEXT_CHARS)
    if (text.length >= MIN_USABLE_TEXT) {
      return { text, note: 'تم استخراج نص صفحة/رابط الكتاب', quality: 'LINK_TEXT' }
    }
    return { text: '', note: 'الرابط مفتوح لكن لم يظهر فيه نص كافٍ قابل للاستخدام', quality: 'LINK_TEXT' }
  } catch (e: any) {
    return { text: '', note: `تعذر الوصول لرابط الكتاب: ${String(e?.message || e).slice(0, 180)}`, quality: 'LINK_TEXT' }
  }
}

export async function hydrateBookContentForExam(book: RawBookForHydration): Promise<HydratedExamBook> {
  const stored = normalizeExtractedText(book.textContent || '', MAX_BOOK_CONTEXT_CHARS)
  if (stored.length >= MIN_STRONG_TEXT && !looksLikeMetadataOnlyText(stored)) {
    return {
      ...book,
      textContent: stored,
      sourceNote: 'نص الكتاب مستخرج ومخزن سابقاً',
      contentQuality: 'STORED_TEXT',
      shouldPersistText: false,
    }
  }

  if (book.data) {
    try {
      const read = await readBufferContent(Buffer.from(book.data, 'base64'), book.mimeType || '', book.fileName, book)
      if (read.text.length >= MIN_USABLE_TEXT) {
        return {
          ...book,
          textContent: read.text,
          sourceNote: read.note || 'تمت قراءة الملف المرفوع للكتاب',
          contentQuality: read.quality,
          shouldPersistText: true,
        }
      }
    } catch (e: any) {
      // نكمل إلى الرابط أو بيانات الكتاب بدل إفشال التوليد.
      console.error('book uploaded file hydration failed:', book.id || book.title, String(e?.message || e).slice(0, 180))
    }
  }

  if (book.link) {
    const fromLink = await fetchLinkContent(book)
    if (fromLink.text.length >= MIN_USABLE_TEXT && !looksLikeMetadataOnlyText(fromLink.text)) {
      return {
        ...book,
        textContent: fromLink.text,
        sourceNote: fromLink.note,
        contentQuality: fromLink.quality,
        shouldPersistText: true,
      }
    }

    return {
      ...book,
      textContent: '',
      sourceNote: `لم يتوفر نص فعلي قابل للقراءة من رابط الكتاب. ${fromLink.note}`,
      contentQuality: 'NO_CONTENT',
      shouldPersistText: false,
    }
  }

  return {
    ...book,
    textContent: '',
    sourceNote: 'لا يوجد نص مستخرج ولا رابط مباشر قابل للقراءة للكتاب',
    contentQuality: 'NO_CONTENT',
    shouldPersistText: false,
  }
}
