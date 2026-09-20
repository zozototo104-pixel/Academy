import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'

const CATALOG_VERSION = 'AACT_PROGRAM_CATALOG_V1'

function asDate(value: any) {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function scrubBook(book: any, includeLargeText: boolean, includeLegacyData: boolean) {
  const { program, knowledgeItems, uploadChunks, ...rest } = book
  return {
    ...rest,
    textContent: includeLargeText ? rest.textContent : null,
    data: includeLegacyData ? rest.data : null,
    note: !includeLargeText && rest.textContent ? 'textContent omitted from backup; use ?includeLargeText=1 to include it.' : undefined,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const includeLargeText = req.nextUrl.searchParams.get('includeLargeText') === '1'
    const includeLegacyData = req.nextUrl.searchParams.get('includeLegacyData') === '1'

    const programs = await db.program.findMany({
      orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
      include: {
        units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }] },
        books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }] },
        knowledgeItems: { orderBy: [{ semester: 'asc' }, { importance: 'desc' }, { createdAt: 'asc' }] },
        questionBankItems: { orderBy: [{ createdAt: 'asc' }] },
        studyGuides: { orderBy: [{ semester: 'asc' }] },
        assignments: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }] },
        programExams: {
          orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
          include: { questions: { orderBy: { order: 'asc' } } },
        },
        microCredentials: { orderBy: [{ createdAt: 'asc' }] },
      },
    })

    const payload = {
      format: CATALOG_VERSION,
      exportedAt: new Date().toISOString(),
      source: 'AACT Admin Program Catalog Export',
      options: { includeLargeText, includeLegacyData },
      warning: 'This backup intentionally excludes students, admissions, enrollments, payments, attempts, answers, sessions, chat logs, and certificates.',
      counts: {
        programs: programs.length,
        units: programs.reduce((s, p) => s + p.units.length, 0),
        books: programs.reduce((s, p) => s + p.books.length, 0),
        knowledgeItems: programs.reduce((s, p) => s + p.knowledgeItems.length, 0),
        questionBankItems: programs.reduce((s, p) => s + p.questionBankItems.length, 0),
        programExams: programs.reduce((s, p) => s + p.programExams.length, 0),
      },
      programs: programs.map((program) => ({
        ...program,
        books: program.books.map((book) => scrubBook(book, includeLargeText, includeLegacyData)),
      })),
    }

    return NextResponse.json(payload, {
      headers: {
        'Content-Disposition': `attachment; filename="aact-program-catalog-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program catalog export error:', e)
    return NextResponse.json({ error: 'تعذر تصدير كتالوج البرامج' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const catalog = body?.catalog || body
    const confirmRestore = body?.confirmRestore || catalog?.confirmRestore
    if (confirmRestore !== 'YES') {
      return NextResponse.json({ error: 'للاستيراد يجب إرسال confirmRestore = YES حتى لا يتم الاستيراد بالخطأ.' }, { status: 400 })
    }
    if (catalog?.format !== CATALOG_VERSION || !Array.isArray(catalog?.programs)) {
      return NextResponse.json({ error: 'ملف كتالوج البرامج غير صحيح أو غير مدعوم.' }, { status: 400 })
    }

    const programIdMap = new Map<string, string>()
    const bookIdMap = new Map<string, string>()
    const unitIdMap = new Map<string, string>()
    const knowledgeIdMap = new Map<string, string>()
    const examIdMap = new Map<string, string>()
    const stats = { programs: 0, units: 0, books: 0, knowledgeItems: 0, questionBankItems: 0, studyGuides: 0, assignments: 0, exams: 0, questions: 0, microCredentials: 0 }

    await db.$transaction(async (tx) => {
      for (const p of catalog.programs) {
        const existing = await tx.program.findUnique({ where: { slug: p.slug }, select: { id: true } }).catch(() => null)
        const programData = stripUndefined({
          slug: cleanText(p.slug, 160),
          titleAr: cleanText(p.titleAr, 260) || 'برنامج بدون عنوان',
          titleEn: p.titleEn ?? null,
          description: p.description || '',
          category: cleanText(p.category, 80) || 'DIPLOMA',
          hours: p.hours ?? null,
          price: p.price ?? null,
          icon: p.icon || 'graduation-cap',
          features: p.features ?? null,
          admissionRules: p.admissionRules ?? undefined,
          order: Number(p.order || 0),
          active: p.active !== false,
          semestersCount: p.semestersCount ?? null,
          academicReadinessStatus: p.academicReadinessStatus || 'NEEDS_PREPARATION',
          registrationStatus: p.registrationStatus || 'OPEN',
          academicApproved: Boolean(p.academicApproved),
          academicApprovedAt: asDate(p.academicApprovedAt) ?? null,
          academicApprovedById: p.academicApprovedById ?? null,
          curriculumDueAt: asDate(p.curriculumDueAt) ?? null,
          curriculumPreparationNote: p.curriculumPreparationNote ?? null,
        })
        const saved = existing
          ? await tx.program.update({ where: { id: existing.id }, data: programData })
          : await tx.program.create({ data: { id: p.id, ...programData } })
        programIdMap.set(p.id, saved.id)
        stats.programs++
      }

      for (const p of catalog.programs) {
        const programId = programIdMap.get(p.id)!

        for (const unit of p.units || []) {
          const data = stripUndefined({
            programId,
            order: Number(unit.order || 0),
            semester: Math.max(1, Number(unit.semester || 1)),
            status: unit.status || 'DRAFT',
            title: unit.title || 'وحدة',
            summary: unit.summary ?? null,
            content: typeof unit.content === 'string' ? unit.content : JSON.stringify(unit.content || []),
            objectives: typeof unit.objectives === 'string' ? unit.objectives : JSON.stringify(unit.objectives || []),
          })
          const saved = await tx.unit.upsert({ where: { id: unit.id }, create: { id: unit.id, ...data }, update: data })
          unitIdMap.set(unit.id, saved.id)
          stats.units++
        }

        for (const book of p.books || []) {
          const data = stripUndefined({
            programId,
            title: book.title || 'كتاب',
            titleEn: book.titleEn ?? null,
            author: book.author ?? null,
            year: book.year ?? null,
            description: book.description ?? null,
            fileName: book.fileName ?? null,
            mimeType: book.mimeType ?? null,
            size: book.size ?? null,
            data: book.data ?? null,
            storageProvider: book.storageProvider ?? null,
            storageKey: book.storageKey ?? null,
            fileUrl: book.fileUrl ?? null,
            link: book.link ?? null,
            textContent: book.textContent ?? null,
            semester: book.semester ?? null,
            levelPolicy: book.levelPolicy ?? null,
            readingDepth: book.readingDepth ?? null,
            assessmentOrientation: book.assessmentOrientation ?? null,
            linkReadStatus: book.linkReadStatus || 'NOT_ATTEMPTED',
            linkReadNote: book.linkReadNote ?? null,
            source: book.source || 'ADMIN',
            createdAt: asDate(book.createdAt) ?? undefined,
          })
          const saved = await tx.book.upsert({ where: { id: book.id }, create: { id: book.id, ...data }, update: data })
          bookIdMap.set(book.id, saved.id)
          stats.books++
        }

        for (const item of p.knowledgeItems || []) {
          const data = stripUndefined({
            programId,
            bookId: item.bookId ? bookIdMap.get(item.bookId) || null : null,
            semester: item.semester ?? null,
            category: item.category || 'CONCEPT',
            title: item.title || 'عنصر معرفة',
            summary: item.summary || '',
            excerpt: item.excerpt ?? null,
            keywords: item.keywords ?? null,
            importance: Number(item.importance || 50),
            sourceNote: item.sourceNote ?? null,
            createdAt: asDate(item.createdAt) ?? undefined,
          })
          const saved = await tx.bookKnowledgeItem.upsert({ where: { id: item.id }, create: { id: item.id, ...data }, update: data })
          knowledgeIdMap.set(item.id, saved.id)
          stats.knowledgeItems++
        }

        for (const q of p.questionBankItems || []) {
          const data = stripUndefined({
            programId,
            knowledgeItemId: q.knowledgeItemId ? knowledgeIdMap.get(q.knowledgeItemId) || null : null,
            bookId: q.bookId ? bookIdMap.get(q.bookId) || null : null,
            unitId: q.unitId ? unitIdMap.get(q.unitId) || null : null,
            semester: q.semester ?? null,
            type: q.type || 'MCQ',
            text: q.text || '',
            options: q.options ?? null,
            correctAnswer: q.correctAnswer ?? null,
            modelAnswer: q.modelAnswer ?? null,
            sourceEvidence: q.sourceEvidence ?? null,
            sourceBookTitle: q.sourceBookTitle ?? null,
            sourceLocator: q.sourceLocator ?? null,
            cognitiveSkill: q.cognitiveSkill ?? null,
            difficulty: q.difficulty ?? 'MEDIUM',
            correctRationale: q.correctRationale ?? null,
            distractorRationales: q.distractorRationales ?? null,
            qualityFlags: q.qualityFlags ?? null,
            reviewNotes: q.reviewNotes ?? null,
            status: q.status || 'PENDING_REVIEW',
            generatedBy: q.generatedBy || 'IMPORT',
            usageCount: Number(q.usageCount || 0),
            qualityScore: Number(q.qualityScore || 70),
            approvedBy: q.approvedBy ?? null,
            approvedAt: asDate(q.approvedAt) ?? null,
            rejectedReason: q.rejectedReason ?? null,
            createdAt: asDate(q.createdAt) ?? undefined,
          })
          await tx.questionBankItem.upsert({ where: { id: q.id }, create: { id: q.id, ...data }, update: data })
          stats.questionBankItems++
        }

        for (const guide of p.studyGuides || []) {
          const data = stripUndefined({
            programId,
            semester: Number(guide.semester || 1),
            title: guide.title || 'دليل دراسة',
            overview: guide.overview || '',
            objectives: guide.objectives ?? null,
            keyTerms: guide.keyTerms ?? null,
            sections: guide.sections ?? null,
            activities: guide.activities ?? null,
            discussionQuestions: guide.discussionQuestions ?? null,
            sourceKnowledgeIds: guide.sourceKnowledgeIds ?? null,
            status: guide.status || 'PUBLISHED',
            generatedBy: guide.generatedBy || 'IMPORT',
            createdAt: asDate(guide.createdAt) ?? undefined,
          })
          await tx.programStudyGuide.upsert({ where: { id: guide.id }, create: { id: guide.id, ...data }, update: data })
          stats.studyGuides++
        }

        for (const a of p.assignments || []) {
          const data = stripUndefined({
            programId,
            title: a.title || 'واجب',
            description: a.description || '',
            semester: Number(a.semester || 1),
            type: a.type || 'REPORT',
            points: Number(a.points || 10),
            weight: Number(a.weight || 0),
            dueDays: a.dueDays ?? null,
            rubric: a.rubric ?? null,
            status: a.status || 'PUBLISHED',
            createdAt: asDate(a.createdAt) ?? undefined,
          })
          await tx.programAssignment.upsert({ where: { id: a.id }, create: { id: a.id, ...data }, update: data })
          stats.assignments++
        }

        for (const ex of p.programExams || []) {
          const { questions = [] } = ex
          const data = stripUndefined({
            programId,
            title: ex.title || 'اختبار',
            status: ex.status || 'REVIEW',
            semester: Number(ex.semester || 1),
            errorNote: ex.errorNote ?? null,
            durationMin: Number(ex.durationMin || 120),
            passScore: Number(ex.passScore || 60),
            totalPoints: Number(ex.totalPoints || 0),
            booksUsed: ex.booksUsed ?? null,
            generatedBy: ex.generatedBy || 'IMPORT',
            createdAt: asDate(ex.createdAt) ?? undefined,
          })
          const savedExam = await tx.programExam.upsert({ where: { id: ex.id }, create: { id: ex.id, ...data }, update: data })
          examIdMap.set(ex.id, savedExam.id)
          stats.exams++
          for (const q of questions) {
            const qData = stripUndefined({
              examId: savedExam.id,
              order: Number(q.order || 0),
              type: q.type || 'MCQ',
              text: q.text || '',
              options: q.options ?? null,
              correctAnswer: q.correctAnswer ?? null,
              modelAnswer: q.modelAnswer ?? null,
              sourceEvidence: q.sourceEvidence ?? null,
              sourceBookTitle: q.sourceBookTitle ?? null,
              sourceChapter: q.sourceChapter ?? null,
              sourceLocator: q.sourceLocator ?? null,
              cognitiveSkill: q.cognitiveSkill ?? null,
              difficulty: q.difficulty ?? null,
              correctRationale: q.correctRationale ?? null,
              distractorRationales: q.distractorRationales ?? null,
              qualityFlags: q.qualityFlags ?? null,
              reviewNotes: q.reviewNotes ?? null,
              approvedBy: q.approvedBy ?? null,
              approvedAt: asDate(q.approvedAt) ?? null,
              rejectedReason: q.rejectedReason ?? null,
              points: Number(q.points || 2),
              status: q.status || 'PUBLISHED',
            })
            await tx.programQuestion.upsert({ where: { id: q.id }, create: { id: q.id, ...qData }, update: qData })
            stats.questions++
          }
        }

        for (const mc of p.microCredentials || []) {
          const data = stripUndefined({
            programId,
            titleAr: mc.titleAr || 'مهارة مصغرة',
            titleEn: mc.titleEn ?? null,
            skillArea: mc.skillArea || 'GENERAL',
            description: mc.description || '',
            learningOutcome: mc.learningOutcome || '',
            criteria: mc.criteria ?? undefined,
            badgeCode: mc.badgeCode || `AACT-MC-${programId}-${mc.id}`,
            active: mc.active !== false,
            createdAt: asDate(mc.createdAt) ?? undefined,
          })
          await tx.microCredential.upsert({ where: { id: mc.id }, create: { id: mc.id, ...data }, update: data })
          stats.microCredentials++
        }
      }
    }, { timeout: 60000 })

    await audit({ id: admin.id, name: admin.name }, 'IMPORT_PROGRAM_CATALOG', 'Program', null, `استيراد كتالوج البرامج: ${stats.programs} برنامج و${stats.units} وحدة و${stats.questionBankItems} سؤال بنك مركزي`)

    return NextResponse.json({ ok: true, stats })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program catalog import error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر استيراد كتالوج البرامج' }, { status: 500 })
  }
}
