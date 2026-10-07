import assert from 'node:assert/strict'
import { buildExamSourceChunks, selectExamSourceChunks } from '../src/lib/exam-source-chunks'
import { validateGeneratedExamQuestionsAgainstSelectedChunks } from '../src/lib/books-ai'

const uploadedText = 'هذا نص أصلي موثوق من كتاب مرفوع يتحدث عن إدارة المخاطر ويشرح كيف ترتبط القرارات بالأدلة والسياق المؤسسي قبل التنفيذ. ويضيف النص أن تجاهل الدليل يؤدي إلى قرارات ضعيفة لا تصلح للتقييم المهني.'
const visionText = 'هذا نص مولد من الرؤية ولا يجب أن يصبح مصدراً أصلياً للامتحان الشامل لأنه ليس نص الكتاب الأصلي المستخرج، حتى لو كان طويلاً ويبدو مفيداً.'

function main() {
  console.log('▶ comprehensive exam validation: accepts uploaded-file evidence and rejects Gemini document evidence')

  const selected = selectExamSourceChunks(buildExamSourceChunks([
    { bookId: 'uploaded-book', bookTitle: 'كتاب مرفوع', text: uploadedText, contentQuality: 'UPLOADED_FILE' },
    { bookId: 'vision-book', bookTitle: 'كتاب رؤية', text: visionText, contentQuality: 'GEMINI_DOCUMENT' },
  ]))

  assert.equal(selected.length, 1)
  assert.equal(selected[0].bookId, 'uploaded-book')

  const validEvidence = 'هذا نص أصلي موثوق من كتاب مرفوع يتحدث عن إدارة المخاطر ويشرح كيف ترتبط القرارات بالأدلة والسياق المؤسسي قبل التنفيذ'
  const invalidVisionEvidence = 'هذا نص مولد من الرؤية ولا يجب أن يصبح مصدراً أصلياً للامتحان الشامل لأنه ليس نص الكتاب الأصلي المستخرج'

  const accepted = validateGeneratedExamQuestionsAgainstSelectedChunks([
    {
      type: 'MCQ',
      text: 'ما الإجراء الأكثر اتساقاً مع موقف الكتاب عند اتخاذ قرار مهني في إدارة المخاطر؟',
      options: [
        'تحليل الدليل والسياق المؤسسي قبل التنفيذ',
        'تجاهل الأدلة والاعتماد على الانطباع الأول',
        'تأجيل جمع المعلومات إلى ما بعد التنفيذ',
        'اختيار قرار عام يصلح لكل الحالات',
      ],
      correctAnswer: 'تحليل الدليل والسياق المؤسسي قبل التنفيذ',
      sourceIndex: 1,
      sourceEvidence: validEvidence,
      difficulty: 'MEDIUM',
      rationale: 'الخيار الصحيح يربط القرار بالدليل والسياق المؤسسي كما ورد في المصدر.',
    },
    {
      type: 'MCQ',
      text: 'أي خيار يعتمد على محتوى Vision غير المقبول كمصدر أصلي؟',
      options: ['قبول نص الرؤية كمصدر', 'رفض نص الرؤية كمصدر', 'تجاهل المصدر', 'اعتماد ملخص عام'],
      correctAnswer: 'رفض نص الرؤية كمصدر',
      sourceIndex: 2,
      sourceEvidence: invalidVisionEvidence,
      difficulty: 'MEDIUM',
      rationale: 'هذا السؤال يجب أن يرفض لأن sourceIndex يشير إلى مصدر غير موجود بعد استبعاد GEMINI_DOCUMENT.',
    },
  ], selected, 'MIX_CORE', { provider: 'TEST', model: 'mock-model' })

  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].sourceBookId, 'uploaded-book')
  assert.equal(accepted[0].sourceIndex, 1)
  assert.equal(accepted[0].sourceEvidence, validEvidence)
  assert.equal(accepted[0].sourceProvider, 'TEST')
  assert.equal(accepted[0].sourceModel, 'mock-model')
  assert.ok(accepted[0].qualityFlags?.includes('SOURCE_LINKED'))
  assert.ok(accepted[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
  assert.ok(!accepted[0].qualityFlags?.includes('SOURCE_GROUNDED'))

  console.log('comprehensive exam source validation: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
