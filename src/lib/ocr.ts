import { getZAI } from '@/lib/ai'

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

/** قراءة صورة مستند بواسطة نموذج الرؤية — تعيد هيكلاً منظماً أو null عند الفشل */
export async function readDocumentImage(
  buffer: Buffer,
  mimeType: string,
  declaredType: string, // التصنيف الذي اختاره الطالب عند الرفع (DEGREE/ID/PHOTO/CV)
  declaredTypeAr: string
): Promise<ImageDocRead | null> {
  try {
    const zai = await getZAI()
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
    const response = await zai.chat.completions.createVision({
      model: process.env.VISION_MODEL || 'glm-5v-turbo',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `هذه صورة مستند رفعها متقدم للالتحاق في أكاديمية تدريب واستشارات، وقد صنّفه هو بنفسه كـ«${declaredTypeAr}».
افحص الصورة بدقة واستخرج ما يظهر فيها. أجب بصيغة JSON فقط بدون أي نص إضافي:
{"readable":true/false,"docTypeDetected":"<نوع الوثيقة كما تظهر: شهادة تخرج/كشف علامات/هوية أو جواز/صورة شخصية/سيرة ذاتية/أخرى>","degreeMentioned":"HIGH_SCHOOL|BACHELOR|MASTER|PHD|OTHER|NONE","nameOnDoc":"<اسم صاحب المستند كما هو مكتوب أو سلسلة فارغة>","institution":"<الجهة المانحة أو سلسلة فارغة>","issueDate":"<التاريخ المكتوب أو سلسلة فارغة>","extractedText":"<كل النص الظاهر في الصورة حرفياً وبأقصى ما تستطيع قراءته>","qualityNote":"<ملاحظة عن وضوح الصورة وجودتها>","matchNote":"<هل نوع الوثيقة يوافق التصنيف المعلن؟ اذكر أي تعارض>"}
ملاحظات: إن كانت الصورة شخصية (فيس بورتريه) فdocTypeDetected=صورة شخصية وreadable=true. اقرأ العربية والإنجليزية معاً. لا تخترع نصاً غير ظاهر.`,
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    })

    const raw = response.choices[0]?.message?.content || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    // النموذج قد يُدرج أسطراً خاماً داخل قيم النص المستخرج فيصبح JSON غير صالح —
    // ننهار كل محارف التحكم إلى مسافات قبل التحليل (النص المستخرج يُنظَّم لاحقاً على أي حال)
    let jsonText = jsonMatch[0]
    let p: any
    try {
      p = JSON.parse(jsonText)
    } catch {
      jsonText = jsonText.replace(/\r\n|\r|\n|\t/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
      p = JSON.parse(jsonText)
    }
    return {
      readable: !!p.readable,
      docTypeDetected: String(p.docTypeDetected || '').slice(0, 120),
      degreeMentioned: (VALID_DEGREES.includes(p.degreeMentioned) ? p.degreeMentioned : 'NONE') as ImageDocRead['degreeMentioned'],
      nameOnDoc: String(p.nameOnDoc || '').slice(0, 120),
      institution: String(p.institution || '').slice(0, 160),
      issueDate: String(p.issueDate || '').slice(0, 40),
      extractedText: String(p.extractedText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
      qualityNote: String(p.qualityNote || '').slice(0, 200),
      matchNote: String(p.matchNote || '').slice(0, 300),
    }
  } catch (e: any) {
    console.error('readDocumentImage failed:', String(e?.message || e).slice(0, 150))
    return null
  }
}

export const DOC_TYPE_AR: Record<string, string> = {
  DEGREE: 'الشهادة وكشف العلامات',
  ID: 'الهوية / الجواز',
  PHOTO: 'الصورة الشخصية',
  CV: 'السيرة الذاتية',
}
