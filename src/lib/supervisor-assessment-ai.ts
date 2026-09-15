import { db } from '@/lib/db'
import { geminiCompleteJson, ensureGeminiKey } from '@/lib/gemini'
import { localAgentConfig, localChatComplete } from '@/lib/open-source-llm'
import { cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput } from '@/lib/knowledge-bank'

type GeneratedQuestion = {
  type: 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'
  text: string
  options?: string[]
  correctAnswer?: string
  modelAnswer?: string
  sourceEvidence?: string
  sourceBookTitle?: string
  cognitiveSkill?: string
  difficulty?: string
  correctRationale?: string
  points?: number
}

function safeJson(text: string): any {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw) } catch {}
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

function normalizeType(t: any): GeneratedQuestion['type'] {
  const x = String(t || '').toUpperCase()
  if (x.includes('TF') || x.includes('TRUE')) return 'TF'
  if (x.includes('SHORT')) return 'SHORT'
  if (x.includes('ESSAY') || x.includes('ARTICLE')) return 'ESSAY'
  return 'MCQ'
}

function fallbackQuestions(knowledge: any[], books: any[], count: number, level: string, specialty: string): GeneratedQuestion[] {
  const items = knowledge.length ? knowledge : books.map((b: any) => ({ title: b.title, summary: b.description || b.readingDepth || b.assessmentOrientation || b.title, sourceNote: b.title, book: b }))
  const out: GeneratedQuestion[] = []
  const wanted = Math.max(1, Math.min(40, count || 8))
  for (let i = 0; i < wanted; i++) {
    const item = items[i % Math.max(1, items.length)] || { title: specialty || 'المقرر', summary: 'مفهوم تطبيقي من الكتاب' }
    const title = String(item.title || 'مفهوم مهني').trim()
    const summary = String(item.summary || item.excerpt || '').slice(0, 450)
    if (i % 4 === 0) {
      out.push({
        type: 'SHORT',
        text: `اشرح بإيجاز كيف يمكن تطبيق مفهوم «${title}» في سياق ${specialty || 'تخصص الطالب'}، مع ربط إجابتك بدليل من الكتاب.`,
        modelAnswer: summary || `إجابة جيدة تربط مفهوم ${title} بموقف مهني وتوضح خطوات تطبيقه ونتائجه.`,
        sourceEvidence: summary,
        sourceBookTitle: item.book?.title || item.sourceNote || books[0]?.title || 'بنك المعرفة',
        cognitiveSkill: 'APPLY',
        difficulty: level.includes('دكتور') ? 'ADVANCED' : level.includes('ماجستير') ? 'MEDIUM' : 'EASY',
        points: 4,
      })
    } else if (i % 4 === 1) {
      out.push({
        type: 'ESSAY',
        text: `حلل أهمية «${title}» في ${specialty || 'الممارسة المهنية'}، ثم اذكر خطراً واحداً عند تطبيقه بشكل خاطئ.`,
        modelAnswer: summary || `ينبغي أن توضح الإجابة معنى المفهوم، أهميته، أثره العملي، وخطر سوء التطبيق.`,
        sourceEvidence: summary,
        sourceBookTitle: item.book?.title || item.sourceNote || books[0]?.title || 'بنك المعرفة',
        cognitiveSkill: 'ANALYZE',
        difficulty: level.includes('دكتور') ? 'ADVANCED' : 'MEDIUM',
        points: 6,
      })
    } else {
      const correct = summary || `يرتبط المفهوم مباشرة بممارسات ${specialty || 'التخصص'} وفق الكتاب.`
      out.push({
        type: 'MCQ',
        text: `أي العبارات التالية أدق في فهم «${title}» وفق سياق ${specialty || 'المقرر'}؟`,
        options: [
          correct.slice(0, 180),
          'هو مصطلح عام لا يحتاج إلى ربط بالسياق المهني أو نتائج التطبيق.',
          'يعتمد فقط على رأي الطالب ولا يحتاج إلى دليل من الكتاب.',
          'يستخدم للحفظ النظري فقط ولا علاقة له بالقرارات أو الأداء المهني.',
        ],
        correctAnswer: '0',
        modelAnswer: correct,
        sourceEvidence: summary,
        sourceBookTitle: item.book?.title || item.sourceNote || books[0]?.title || 'بنك المعرفة',
        cognitiveSkill: i % 2 === 0 ? 'UNDERSTAND' : 'APPLY',
        difficulty: 'MEDIUM',
        correctRationale: 'الخيار الصحيح يربط المفهوم بالكتاب والسياق المهني بدلاً من الحفظ العام.',
        points: 2,
      })
    }
  }
  return out
}

async function completionJson(system: string, prompt: string): Promise<any> {
  const local = await localAgentConfig().catch(() => null)
  if (local?.enabled) {
    try {
      const out = await localChatComplete({
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        temperature: 0.25,
        maxTokens: 4500,
      })
      const parsed = safeJson(out)
      if (parsed) return parsed
    } catch (e) {
      console.error('local assessment generation failed', e)
    }
  }
  const hasGemini = await ensureGeminiKey().catch(() => false)
  if (hasGemini) {
    const out = await geminiCompleteJson({
      system,
      history: [{ role: 'user', text: prompt }],
      temperature: 0.2,
      maxOutputTokens: 5000,
    })
    return safeJson(out)
  }
  return null
}

export async function generateSupervisorQuestions(opts: {
  programId: string
  bookIds?: string[]
  semester?: number
  count?: number
  assessmentType?: string
  studentName?: string
  levelLabel?: string
  specialty?: string
}) {
  const count = Math.max(3, Math.min(40, Number(opts.count || 10)))
  const whereBooks: any = { programId: opts.programId }
  if (opts.bookIds?.length) whereBooks.id = { in: opts.bookIds }
  if (opts.semester) whereBooks.OR = [{ semester: opts.semester }, { semester: null }]
  const [program, books, knowledge] = await Promise.all([
    db.program.findUnique({ where: { id: opts.programId }, select: { titleAr: true, category: true, description: true } }),
    db.book.findMany({ where: whereBooks, take: 8, select: { id: true, title: true, titleEn: true, description: true, readingDepth: true, assessmentOrientation: true, semester: true } }),
    db.bookKnowledgeItem.findMany({
      where: { programId: opts.programId, ...(opts.bookIds?.length ? { bookId: { in: opts.bookIds } } : {}), ...(opts.semester ? { OR: [{ semester: opts.semester }, { semester: null }] } : {}) },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
      include: { book: { select: { title: true } } },
    }),
  ])
  const level = opts.levelLabel || (program?.category === 'DOCTORATE' ? 'دكتوراه مهنية' : program?.category === 'MASTERS' ? 'ماجستير مهني' : program?.category === 'DIPLOMA' ? 'دبلوم مهني' : 'برنامج مهني')
  const specialty = opts.specialty || program?.titleAr || 'تخصص الطالب'
  const cleanKnowledge = knowledge.map((k: any) => ({
    ...k,
    title: cleanAcademicGeneratedText(k.title, 220),
    summary: cleanAcademicGeneratedText(k.summary, 900),
    excerpt: k.excerpt ? cleanAcademicGeneratedText(k.excerpt, 500) : '',
  })).filter((k: any) => k.title && k.summary && !looksLikeBrokenAcademicOutput(k.title, { allowShort: true }) && !looksLikeBrokenAcademicOutput(k.summary) && (!k.excerpt || !looksLikeBrokenAcademicOutput(k.excerpt)))
  const context = [
    `البرنامج: ${program?.titleAr || specialty}`,
    `المستوى: ${level}`,
    `نوع التقييم: ${opts.assessmentType || 'اختبار خاص من المشرف'}`,
    `الفصل: ${opts.semester || 1}`,
    `الكتب: ${books.map((b) => b.title).join(' | ') || 'غير محدد'}`,
    `بنك المعرفة:` ,
    ...cleanKnowledge.slice(0, 35).map((k: any, i: number) => `${i + 1}. [${k.category}] ${k.title}: ${k.summary}${k.excerpt ? ` — مقتطف: ${k.excerpt.slice(0, 240)}` : ''}${k.book?.title ? ` — المصدر: ${k.book.title}` : ''}`),
  ].join('\n')
  const system = 'أنت خبير قياس وتقويم أكاديمي مهني. أعد JSON صالحاً فقط بدون Markdown. الأسئلة يجب أن تكون واضحة ومنطقية ومبنية حصراً على بنك المعرفة والكتب، وليست عبارات مشوهة أو مترجمة آلياً.'
  const prompt = `ولّد ${count} سؤالاً خاصاً بطالب واحد. راعِ أن أسئلة الدبلوم مباشرة وتطبيقية، الماجستير تحليلية، والدكتوراه نقدية ومتقدمة.\n\n${context}\n\nأعد الصيغة التالية فقط:\n{ "questions": [ { "type": "MCQ|TF|SHORT|ESSAY", "text": "...", "options": ["..."], "correctAnswer": "0", "modelAnswer": "...", "sourceEvidence": "دليل قصير من المعرفة", "sourceBookTitle": "اسم الكتاب", "cognitiveSkill": "UNDERSTAND|APPLY|ANALYZE|EVALUATE", "difficulty": "EASY|MEDIUM|ADVANCED", "correctRationale": "سبب الصحة", "points": 2 } ] }`
  try {
    const parsed = await completionJson(system, prompt)
    const arr = Array.isArray(parsed) ? parsed : parsed?.questions
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(0, count).map((q: any, idx: number) => ({
        type: normalizeType(q.type),
        text: String(q.text || '').trim() || `سؤال ${idx + 1}`,
        options: Array.isArray(q.options) ? q.options.map((x: any) => String(x)).slice(0, 5) : undefined,
        correctAnswer: String(q.correctAnswer ?? q.correct_answer ?? '').trim(),
        modelAnswer: String(q.modelAnswer || q.model_answer || '').trim(),
        sourceEvidence: String(q.sourceEvidence || q.source_evidence || '').trim(),
        sourceBookTitle: String(q.sourceBookTitle || q.source_book_title || '').trim(),
        cognitiveSkill: String(q.cognitiveSkill || q.skill || 'APPLY').trim(),
        difficulty: String(q.difficulty || 'MEDIUM').trim(),
        correctRationale: String(q.correctRationale || q.rationale || '').trim(),
        points: Math.max(1, Math.min(10, Number(q.points || (normalizeType(q.type) === 'ESSAY' ? 6 : normalizeType(q.type) === 'SHORT' ? 4 : 2)))),
      })).filter((q: GeneratedQuestion) => q.text.length > 8)
    }
  } catch (e) {
    console.error('supervisor assessment AI generation failed', e)
  }
  return fallbackQuestions(knowledge, books, count, level, specialty)
}

export async function gradeSupervisorAttemptWithAi(opts: {
  assessmentTitle: string
  passScore: number
  questions: { id: string; type: string; text: string; correctAnswer?: string | null; modelAnswer?: string | null; points: number }[]
  answers: { questionId: string; answerText?: string | null; selectedOption?: number | null }[]
}) {
  const total = opts.questions.reduce((s, q) => s + (q.points || 0), 0) || 1
  let earned = 0
  const perQuestion: Record<string, { points: number; isCorrect?: boolean; feedback: string }> = {}
  for (const q of opts.questions) {
    const ans = opts.answers.find((a) => a.questionId === q.id)
    if (q.type === 'MCQ' || q.type === 'TF') {
      const correct = String(q.correctAnswer ?? '').trim()
      const selected = ans?.selectedOption != null ? String(ans.selectedOption) : String(ans?.answerText || '').trim()
      const ok = correct !== '' && selected === correct
      const pts = ok ? q.points : 0
      earned += pts
      perQuestion[q.id] = { points: pts, isCorrect: ok, feedback: ok ? 'إجابة صحيحة.' : `الإجابة غير صحيحة. الإجابة الصحيحة: ${correct || 'غير محددة'}.` }
    }
  }

  const openQuestions = opts.questions.filter((q) => q.type === 'SHORT' || q.type === 'ESSAY')
  if (openQuestions.length) {
    const system = 'أنت مصحح أكاديمي عادل. أعد JSON فقط. صحح بإيجاز وفق الإجابة النموذجية ولا تجامل الطالب.'
    const prompt = `صحح الأسئلة المفتوحة في اختبار: ${opts.assessmentTitle}\nأعد: {"grades":[{"questionId":"...","points":0,"feedback":"..."}],"overall":"..."}\n\nالأسئلة والإجابات:\n${openQuestions.map((q) => {
      const ans = opts.answers.find((a) => a.questionId === q.id)
      const studentAnswer = ans?.answerText || (ans?.selectedOption != null ? String(ans.selectedOption) : 'لم يجب')
      return `ID=${q.id}\nالسؤال: ${q.text}\nالنقاط: ${q.points}\nالإجابة النموذجية: ${q.modelAnswer || 'غير متاحة'}\nإجابة الطالب: ${studentAnswer}`
    }).join('\n---\n')}`
    let parsed: any = null
    try { parsed = await completionJson(system, prompt) } catch (e) { console.error('ai grading failed', e) }
    const grades = Array.isArray(parsed?.grades) ? parsed.grades : []
    for (const q of openQuestions) {
      const g = grades.find((x: any) => String(x.questionId) === q.id)
      const pts = Math.max(0, Math.min(q.points, Number(g?.points ?? 0)))
      earned += pts
      perQuestion[q.id] = { points: pts, isCorrect: pts >= q.points * 0.6, feedback: String(g?.feedback || 'تم التصحيح آلياً وفق الإجابة النموذجية.').slice(0, 1000) }
    }
  }

  const score = Math.round((earned / total) * 100)
  const weak = Object.values(perQuestion).filter((g) => (g.points || 0) <= 0).length
  const feedback = score >= opts.passScore
    ? `أداء جيد. نتيجتك ${score}%. راجع الملاحظات التفصيلية لكل سؤال لتعزيز الإجابات.`
    : `تحتاج مراجعة. نتيجتك ${score}%. ركّز على الأسئلة التي فقدت فيها نقاطاً وعد إلى دليل الكتاب قبل إعادة المحاولة.`
  return { score, passed: score >= opts.passScore, feedback: weak ? `${feedback} عدد نقاط القصور الواضحة: ${weak}.` : feedback, perQuestion }
}
