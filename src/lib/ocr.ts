import { getZAI } from '@/lib/ai'
import { ensureGeminiKey, geminiVisionJson } from '@/lib/gemini'

// ===== قراءة صور المستندات (Vision OCR) =====
// خبير الذكاء الاصطناعي «يرى» صور المستندات المرفوعة ويستخرج نوع الوثيقة، النص الظاهر،
// الدرجة العلمية، الاسم، الجهة، والتعارض مع التصنيف المطلوب. نستخدم Gemini Vision أولاً،
// ثم GLM Vision كاحتياط، مع تحويل الصور إلى JPEG قياسي قبل الإرسال حتى لا تفشل صور iPhone/HEIC/WebP.

export interface ImageDocRead {
  readable: boolean
  docTypeDetected: string
  degreeMentioned: 'HIGH_SCHOOL' | 'BACHELOR' | 'MASTER' | 'PHD' | 'OTHER' | 'NONE'
  nameOnDoc: string
  institution: string
  issueDate: string
  extractedText: string
  qualityNote: string
  matchNote: string
}

const VALID_DEGREES = ['HIGH_SCHOOL', 'BACHELOR', 'MASTER', 'PHD', 'OTHER', 'NONE']

export function inferMimeFromFileName(fileName?: string | null, fallback = 'application/octet-stream'): string {
  const name = String(fileName || '').toLowerCase()
  if (/\.jpe?g$/.test(name)) return 'image/jpeg'
  if (/\.png$/.test(name)) return 'image/png'
  if (/\.webp$/.test(name)) return 'image/webp'
  if (/\.heic$/.test(name)) return 'image/heic'
  if (/\.heif$/.test(name)) return 'image/heif'
  if (/\.pdf$/.test(name)) return 'application/pdf'
  if (/\.docx$/.test(name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (/\.xlsx$/.test(name)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (/\.csv$/.test(name)) return 'text/csv'
  if (/\.txt$/.test(name)) return 'text/plain'
  return fallback || 'application/octet-stream'
}

export function isVisualFile(mimeType: string, fileName?: string | null): boolean {
  const mime = String(mimeType || '').toLowerCase()
  const inferred = inferMimeFromFileName(fileName, mime)
  return inferred.startsWith('image/') || inferred === 'application/pdf'
}

function cleanJson(raw: string): string | null {
  const txt = String(raw || '').trim()
  if (!txt) return null
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const body = fenced || txt
  const jsonMatch = body.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  return jsonMatch[0]
}

function fallbackReadFromRaw(raw: string, declaredTypeAr: string): ImageDocRead | null {
  const clean = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return {
    readable: clean.length > 20,
    docTypeDetected: `وصف بصري غير منسق JSON — التصنيف المعلن: ${declaredTypeAr}`,
    degreeMentioned: /ماجستير|master/i.test(clean) ? 'MASTER'
      : /بكالوريوس|bachelor|ليسانس/i.test(clean) ? 'BACHELOR'
        : /دكتوراه|doctorate|phd/i.test(clean) ? 'PHD'
          : /ثانوي|secondary/i.test(clean) ? 'HIGH_SCHOOL'
            : 'NONE',
    nameOnDoc: '',
    institution: '',
    issueDate: '',
    extractedText: clean.slice(0, 3500),
    qualityNote: 'تم استخراج وصف/نص من نموذج الرؤية لكنه لم يرجع بصيغة JSON مثالية',
    matchNote: 'يحتاج تحقق قواعدي من نوع المرفق مقارنة بالتصنيف المعلن',
  }
}

function publicVisionError(e: any): string {
  const raw = String(e?.message || e || '')
  if (/503|UNAVAILABLE|high demand|overloaded|service unavailable|temporar/i.test(raw)) {
    return 'خدمة قراءة الصور مشغولة مؤقتاً؛ أعد التحليل بعد قليل أو افحص الصورة يدوياً من زر المعاينة.'
  }
  if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw)) {
    return 'انتهت حصة قراءة الصور مؤقتاً؛ فعّل Billing أو أعد التحليل لاحقاً.'
  }
  if (/API_KEY|401|403|PERMISSION|UNAUTHENTICATED/i.test(raw)) {
    return 'مفتاح Gemini لا يملك صلاحية قراءة الصور أو غير صالح.'
  }
  if (/payload|too large|size|413/i.test(raw)) {
    return 'حجم الصورة كبير جداً على التحليل الآلي؛ ارفع نسخة أوضح وأصغر.'
  }
  return 'تعذر تشغيل قارئ الصور الآلي لهذا المرفق؛ استخدم المعاينة اليدوية أو أعد التحليل لاحقاً.'
}

function parseVisionJson(raw: string, declaredTypeAr = ''): ImageDocRead | null {
  const json = cleanJson(raw)
  if (!json) return fallbackReadFromRaw(raw, declaredTypeAr)
  let p: any
  try {
    p = JSON.parse(json)
  } catch {
    try {
      const repaired = json
        .replace(/\r\n|\r|\n|\t/g, ' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
      p = JSON.parse(repaired)
    } catch {
      return fallbackReadFromRaw(raw, declaredTypeAr)
    }
  }
  return {
    readable: !!p.readable,
    docTypeDetected: String(p.docTypeDetected || '').slice(0, 140),
    degreeMentioned: (VALID_DEGREES.includes(p.degreeMentioned) ? p.degreeMentioned : 'NONE') as ImageDocRead['degreeMentioned'],
    nameOnDoc: String(p.nameOnDoc || '').slice(0, 140),
    institution: String(p.institution || '').slice(0, 180),
    issueDate: String(p.issueDate || '').slice(0, 60),
    extractedText: String(p.extractedText || '').replace(/\s+/g, ' ').trim().slice(0, 3500),
    qualityNote: String(p.qualityNote || '').slice(0, 300),
    matchNote: String(p.matchNote || '').slice(0, 500),
  }
}

function promptForImage(declaredTypeAr: string): string {
  return `هذه صورة أو ملف بصري مرفوع ضمن طلب التحاق في أكاديمية تدريب واستشارات. التصنيف الذي اختاره الطالب عند الرفع هو: «${declaredTypeAr}».

المطلوب منك بدقة:
- اقرأ كل نص ظاهر في الملف بالعربية أو الإنجليزية.
- صف الشيء الظاهر فعلياً حتى لو لم يكن مستنداً صحيحاً: شعار، ختم، صورة عامة، تقرير، شهادة، هوية، سيرة، صورة شخصية، لقطة شاشة، واجهة موقع، جهاز، إلخ.
- لا تكتب "تعذر" إذا كان هناك أي نص أو شكل واضح؛ اكتب ما تراه وما استطعت قراءته.
- إذا كانت الصورة لقطة شاشة لواجهة نظام أو لوحة تحكم أو محادثة أو صفحة Vercel/متصفح لا تعرض مستنداً رسمياً، اجعل docTypeDetected="لقطة شاشة واجهة نظام" وreadable=false.
- إذا كانت الصورة لقطة شاشة أو صورة هاتف لكنها تعرض مستنداً رسمياً بوضوح مثل شهادة جامعة، كشف علامات، هوية/جواز، أو سيرة ذاتية، فلا ترفضها لمجرد أنها لقطة شاشة؛ صنّف المستند الحقيقي الظاهر، واجعل readable=true إذا أمكن قراءة الاسم/الدرجة/الجهة/النصوص الأساسية، واذكر في qualityNote أنها لقطة شاشة/صورة لمستند تحتاج مراجعة أصلية لاحقاً.
- إذا كان الظاهر جهازاً أو أداة إلكترونية أو منتجاً وليس وجه إنسان أو مستنداً رسمياً، اجعل docTypeDetected="صورة جهاز/منتج" وreadable=false.
- إذا كان الملف لا يثبت التصنيف المطلوب، قل ذلك في matchNote بوضوح.
- إذا كان شعاراً أو صورة لا علاقة لها بالمطلوب، اجعل readable=false لكن اذكر وصفه والنص الظاهر عليه في extractedText.
- إذا كانت صورة وجه إنسان واضحة فعلاً فقط، اجعل docTypeDetected="صورة شخصية" وreadable=true حتى لو لا يوجد نص.
- لا تخترع اسماً أو مؤهلاً أو مؤسسة غير ظاهرة. لا تعتبر عنوان خانة الرفع مثل «الشهادة وكشف العلامات» دليلاً على أن الصورة شهادة.

أجب بصيغة JSON فقط:
{"readable":true/false,"docTypeDetected":"<ما هو الشيء الظاهر فعلاً>","degreeMentioned":"HIGH_SCHOOL|BACHELOR|MASTER|PHD|OTHER|NONE","nameOnDoc":"<اسم صاحب المستند إن ظهر>","institution":"<الجهة المانحة إن ظهرت>","issueDate":"<التاريخ إن ظهر>","extractedText":"<النص الظاهر حرفياً قدر الإمكان، أو وصف مختصر لما يظهر إن لم يوجد نص>","qualityNote":"<وضوح الملف وما تعذر قراءته إن وجد>","matchNote":"<هل يطابق التصنيف المعلن؟ إن لم يطابق، لماذا؟>"}`
}

async function normalizeVisionInput(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string; converted: boolean }> {
  const mime = String(mimeType || '').toLowerCase()
  if (!mime.startsWith('image/')) return { buffer, mimeType: mime || 'application/pdf', converted: false }

  try {
    const mod = await import('sharp')
    const sharp = (mod as any).default || mod
    const out = await sharp(buffer, { limitInputPixels: 24_000_000 })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer()
    if (out?.length) return { buffer: out, mimeType: 'image/jpeg', converted: true }
  } catch {
    // نرجع الأصل؛ قد تكون صيغة مدعومة أصلاً مثل PNG/JPEG أو قد يفحصها النموذج مباشرة.
  }

  const safeMime = mime === 'image/jpg' ? 'image/jpeg' : mime
  return { buffer, mimeType: safeMime || 'image/jpeg', converted: false }
}

async function readWithGemini(buffer: Buffer, mimeType: string, declaredTypeAr: string): Promise<ImageDocRead | null> {
  const hasKey = await ensureGeminiKey().catch(() => false)
  if (!hasKey) return null
  const normalized = await normalizeVisionInput(buffer, mimeType)
  const raw = await geminiVisionJson({
    prompt: promptForImage(declaredTypeAr),
    images: [{ mimeType: normalized.mimeType, dataBase64: normalized.buffer.toString('base64') }],
    temperature: 0.05,
    maxOutputTokens: 2400,
  })
  const parsed = parseVisionJson(raw, declaredTypeAr)
  if (parsed && normalized.converted) {
    parsed.qualityNote = `${parsed.qualityNote || ''} — تم تحويل الصورة داخلياً إلى JPEG لتحسين القراءة`.trim()
  }
  return parsed
}

async function readWithLegacyZai(buffer: Buffer, mimeType: string, declaredTypeAr: string): Promise<ImageDocRead | null> {
  const normalized = await normalizeVisionInput(buffer, mimeType)
  const zai = await getZAI()
  const dataUrl = `data:${normalized.mimeType};base64,${normalized.buffer.toString('base64')}`
  const response = await zai.chat.completions.createVision({
    model: process.env.VISION_MODEL || 'glm-5v-turbo',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptForImage(declaredTypeAr) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    thinking: { type: 'disabled' },
  })

  const raw = response.choices[0]?.message?.content || ''
  return parseVisionJson(raw, declaredTypeAr)
}

/** قراءة صورة/ملف بصري بواسطة نموذج الرؤية — Gemini أولاً ثم GLM كاحتياط */
export async function readDocumentImage(
  buffer: Buffer,
  mimeType: string,
  declaredType: string,
  declaredTypeAr: string,
  fileName?: string | null
): Promise<ImageDocRead | null> {
  const effectiveMime = inferMimeFromFileName(fileName, mimeType || 'application/octet-stream')
  const errors: string[] = []

  try {
    const geminiRead = await readWithGemini(buffer, effectiveMime, declaredTypeAr)
    if (geminiRead) return geminiRead
  } catch (e: any) {
    errors.push(publicVisionError(e))
    console.error('Gemini Vision failed:', String(e?.message || e).slice(0, 500))
  }

  try {
    const legacyRead = await readWithLegacyZai(buffer, effectiveMime, declaredTypeAr)
    if (legacyRead) return legacyRead
  } catch (e: any) {
    errors.push(publicVisionError(e))
    console.error('Legacy Vision failed:', String(e?.message || e).slice(0, 500))
  }

  const publicReason = [...new Set(errors)].join(' / ') || 'تعذر تشغيل قارئ الصور الآلي لهذا المرفق.'
  return {
    readable: false,
    docTypeDetected: 'لم تُقرأ الصورة آلياً',
    degreeMentioned: 'NONE',
    nameOnDoc: '',
    institution: '',
    issueDate: '',
    extractedText: `وصل المرفق كملف بصري (${effectiveMime}) لكن لم يكتمل تحليله آلياً الآن.` ,
    qualityNote: publicReason,
    matchNote: `لا يمكن احتساب هذا المرفق كمطابق للتصنيف «${declaredType || declaredTypeAr}» قبل إعادة التحليل أو المراجعة اليدوية.`,
  }
}

export const DOC_TYPE_AR: Record<string, string> = {
  DEGREE: 'الشهادة وكشف العلامات',
  ID: 'الهوية / الجواز',
  PHOTO: 'الصورة الشخصية',
  CV: 'السيرة الذاتية',
}
