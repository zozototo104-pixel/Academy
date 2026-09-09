import { getZAI } from '@/lib/ai'
import { ensureGeminiKey, geminiVisionJson } from '@/lib/gemini'

// ===== قراءة صور المستندات (Vision OCR) =====
// خبير الذكاء الاصطناعي «يرى» صور المستندات المرفوعة (JPG/PNG/WebP) ويستخرج:
// نوع الوثيقة، الدرجة العلمية المذكورة، اسم الطالب عليها، الجهة المانحة، التاريخ، وسلامة القراءة
// — لتصبح الصور جزءاً من أدلة التقييم الذكي لطلب الالتحاق بدل اكتفائها بـ"تحتاج معاينة يدوية".

export interface ImageDocRead {
  readable: boolean // هل استطاع الذكاء قراءة الصورة فعلاً
  docTypeDetected: string // نوع المستند كما ظهر في الصورة (شهادة، هوية، سيرة ذاتية...)
  degreeMentioned: 'HIGH_SCHOOL' | 'BACHELOR' | 'MASTER' | 'PHD' | 'OTHER' | 'NONE'
  nameOnDoc: string
  institution: string
  issueDate: string
  extractedText: string // النص الظاهر في الصورة كما استُخرج حرفياً
  qualityNote: string // ملاحظة جودة الصورة (وضوح/قطع/ضبابية)
  matchNote: string // ملاحظة مطابقة: هل نوع المستند يوافق ما صُنّف له عند الرفع
}

const VALID_DEGREES = ['HIGH_SCHOOL', 'BACHELOR', 'MASTER', 'PHD', 'OTHER', 'NONE']

function cleanJson(raw: string): string | null {
  const txt = String(raw || '').trim()
  if (!txt) return null
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const body = fenced || txt
  const jsonMatch = body.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  return jsonMatch[0]
}

function parseVisionJson(raw: string): ImageDocRead | null {
  const json = cleanJson(raw)
  if (!json) return null
  let p: any
  try {
    p = JSON.parse(json)
  } catch {
    const repaired = json
      .replace(/\r\n|\r|\n|\t/g, ' ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    p = JSON.parse(repaired)
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
  return `هذه صورة مرفق رفعها متقدم للالتحاق في أكاديمية تدريب واستشارات، وقد صنّفه هو بنفسه كـ«${declaredTypeAr}».

المطلوب:
- افحص الصورة بصرياً بدقة، واقرأ كل نص ظاهر فيها بالعربية أو الإنجليزية.
- لا تقل "تعذر" إذا كان في الصورة نص مقروء أو عناصر واضحة؛ استخرج ما تستطيع وصفه.
- إذا كانت الصورة شعاراً، ختمًا فقط، أيقونة، لقطة زخرفية، صورة غير شخصية، بطاقة لا تثبت المطلوب، أو لا تحتوي مستنداً تعليمياً/هوية/سيرة حقيقية، اجعل readable=false لكن اذكر بوضوح ماذا ترى في docTypeDetected وextractedText وqualityNote.
- إذا كانت صورة وجه/بورتريه شخصية واضحة، اجعل docTypeDetected="صورة شخصية" وreadable=true حتى لو لا يوجد نص.
- لا تخترع درجة علمية أو اسم أو مؤسسة إذا لم يظهر ذلك فعلياً.

أجب بصيغة JSON فقط بدون أي نص إضافي:
{"readable":true/false,"docTypeDetected":"<ما هو الشيء الظاهر فعلاً: شهادة تخرج/كشف علامات/هوية أو جواز/صورة شخصية/سيرة ذاتية/شعار/صورة عامة/مستند آخر>","degreeMentioned":"HIGH_SCHOOL|BACHELOR|MASTER|PHD|OTHER|NONE","nameOnDoc":"<اسم صاحب المستند كما هو مكتوب أو سلسلة فارغة>","institution":"<الجهة المانحة أو سلسلة فارغة>","issueDate":"<التاريخ المكتوب أو سلسلة فارغة>","extractedText":"<كل النص الظاهر في الصورة حرفياً قدر الإمكان، أو وصف مختصر لما يظهر إن لم يكن نصاً>","qualityNote":"<ملاحظة عن وضوح الصورة وما الذي استطعت أو لم تستطع قراءته>","matchNote":"<هل نوع الوثيقة يوافق التصنيف المعلن؟ اذكر التعارض إن وجد>"}`
}

async function readWithGemini(buffer: Buffer, mimeType: string, declaredTypeAr: string): Promise<ImageDocRead | null> {
  const hasKey = await ensureGeminiKey().catch(() => false)
  if (!hasKey) return null
  const raw = await geminiVisionJson({
    prompt: promptForImage(declaredTypeAr),
    images: [{ mimeType, dataBase64: buffer.toString('base64') }],
    temperature: 0.05,
    maxOutputTokens: 2400,
  })
  return parseVisionJson(raw)
}

async function readWithLegacyZai(buffer: Buffer, mimeType: string, declaredTypeAr: string): Promise<ImageDocRead | null> {
  const zai = await getZAI()
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
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
  return parseVisionJson(raw)
}

/** قراءة صورة مستند بواسطة نموذج الرؤية — Gemini أولاً ثم GLM كاحتياط */
export async function readDocumentImage(
  buffer: Buffer,
  mimeType: string,
  declaredType: string, // التصنيف الذي اختاره الطالب عند الرفع (DEGREE/ID/PHOTO/CV)
  declaredTypeAr: string
): Promise<ImageDocRead | null> {
  const errors: string[] = []
  try {
    const geminiRead = await readWithGemini(buffer, mimeType, declaredTypeAr)
    if (geminiRead) return geminiRead
  } catch (e: any) {
    errors.push(`Gemini Vision: ${String(e?.message || e).slice(0, 180)}`)
  }

  try {
    const legacyRead = await readWithLegacyZai(buffer, mimeType, declaredTypeAr)
    if (legacyRead) return legacyRead
  } catch (e: any) {
    errors.push(`Legacy Vision: ${String(e?.message || e).slice(0, 180)}`)
  }

  console.error('readDocumentImage failed:', errors.join(' | '))
  return {
    readable: false,
    docTypeDetected: 'لم ينجح محرك الرؤية في قراءة الصورة',
    degreeMentioned: 'NONE',
    nameOnDoc: '',
    institution: '',
    issueDate: '',
    extractedText: '',
    qualityNote: errors.join(' | ').slice(0, 300) || 'فشل غير معروف في قراءة الصورة',
    matchNote: `لم يمكن التحقق من مطابقة الصورة مع التصنيف المعلن (${declaredType || declaredTypeAr})`,
  }
}

export const DOC_TYPE_AR: Record<string, string> = {
  DEGREE: 'الشهادة وكشف العلامات',
  ID: 'الهوية / الجواز',
  PHOTO: 'الصورة الشخصية',
  CV: 'السيرة الذاتية',
}
