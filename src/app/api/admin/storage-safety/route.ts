import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

function bytes(n: number) {
  return Math.max(0, Math.round(Number(n || 0)))
}

function approxBase64Bytes(value?: string | null) {
  if (!value) return 0
  return Math.floor(value.length * 0.75)
}

function asNumber(value: unknown) {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value || 0)
  return 0
}

async function heavyColumnReport(label: string, table: string, column: string, note: string) {
  const rows = await db.$queryRawUnsafe<{ rows: bigint; chars: bigint }[]>(
    `SELECT COUNT(*)::bigint AS rows, COALESCE(SUM(LENGTH("${column}")), 0)::bigint AS chars FROM "${table}" WHERE "${column}" IS NOT NULL AND LENGTH("${column}") > 0`
  )
  const first = rows[0]
  const rowCount = asNumber(first?.rows)
  const chars = asNumber(first?.chars)
  return {
    key: `${table}.${column}`,
    label,
    table,
    column,
    rows: rowCount,
    chars,
    approxBytes: Math.floor(chars * 0.75),
    status: rowCount === 0 ? 'SAFE' : chars > 50 * 1024 * 1024 ? 'HIGH_RISK' : chars > 5 * 1024 * 1024 ? 'WARNING' : 'WATCH',
    note,
  }
}

export async function GET() {
  try {
    await requireAdmin()

    const [books, chunks, questionRefs, drafts, reviewExams, assignmentStorageRows, defenseRecordingRows, heavyDbFiles] = await Promise.all([
      db.book.findMany({
        select: {
          id: true,
          title: true,
          fileName: true,
          size: true,
          data: true,
          storageProvider: true,
          storageKey: true,
          fileUrl: true,
          link: true,
          createdAt: true,
          program: { select: { titleAr: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.bookUploadChunk.findMany({ select: { id: true, bookId: true, size: true, fileName: true, createdAt: true } }),
      db.questionBankItem.findMany({ select: { id: true, bookId: true, unitId: true } }),
      db.examDraft.findMany({ select: { id: true, examId: true, examType: true, userId: true, updatedAt: true } }),
      db.programExam.findMany({ where: { status: 'REVIEW' }, select: { id: true, title: true, programId: true, createdAt: true, _count: { select: { questions: true } } } }),
      db.assignmentSubmission.findMany({
        where: { fileStorageKey: { not: null } },
        select: { id: true, fileName: true, size: true, fileStorageProvider: true, fileStorageKey: true, fileUrl: true, submittedAt: true },
        orderBy: { submittedAt: 'desc' },
        take: 20,
      }),
      db.thesisSubmission.findMany({
        where: { recordingStorageKey: { not: null } },
        select: { id: true, recordingMime: true, recordingSize: true, recordingStorageProvider: true, recordingStorageKey: true, recordingUrl: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      Promise.all([
        heavyColumnReport('كتب قديمة مخزنة داخل قاعدة البيانات', 'Book', 'data', 'الكتب الجديدة يجب أن تكون على R2. هذا الحقل legacy فقط.'),
        heavyColumnReport('مرفقات الواجبات داخل قاعدة البيانات', 'AssignmentSubmission', 'data', 'هذا يحتاج نقله إلى R2 قبل توسعة الطلاب إذا بدأت الواجبات المرفقة.'),
        heavyColumnReport('تسجيلات مناقشة البحث داخل قاعدة البيانات', 'ThesisSubmission', 'recordingData', 'تسجيلات الفيديو يجب أن تنتقل إلى R2 أو خدمة تسجيل خارجية قبل التوسع.'),
        heavyColumnReport('الرسائل الصوتية داخل قاعدة البيانات', 'SupervisorChannelMessage', 'audioData', 'الملاحظات الصوتية القصيرة قد تكبر مع كثرة الطلاب؛ الأفضل نقلها إلى R2.'),
        heavyColumnReport('لقطات مراقبة الاختبارات داخل قاعدة البيانات', 'ProgramExamAttempt', 'proctoringSnapshot', 'لقطات الكاميرا يجب ألا تبقى داخل Neon عند استخدام المراقبة على نطاق واسع.'),
      ]),
    ])

    const bookIds = new Set(books.map((b) => b.id))
    const unitIds = new Set((await db.unit.findMany({ select: { id: true } })).map((u) => u.id))
    const unitExamIds = new Set((await db.exam.findMany({ select: { id: true } })).map((e) => e.id))
    const programExamIds = new Set((await db.programExam.findMany({ select: { id: true } })).map((e) => e.id))

    const linkedR2 = books.filter((b) => b.storageProvider === 's3' && b.storageKey)
    const linkedLocal = books.filter((b) => b.storageProvider === 'local' && b.storageKey)
    const externalLinks = books.filter((b) => b.storageProvider === 'external-url' || (!!b.link && !b.storageKey))
    const legacyBase64 = books.filter((b) => !!b.data)

    const suspiciousBooks = books.filter((b) => {
      const hasFileIntent = !!b.fileName || Number(b.size || 0) > 0
      const hasAnyUsableSource = !!b.storageKey || !!b.fileUrl || !!b.data || !!b.link
      const providerMissingKey = !!b.storageProvider && b.storageProvider !== 'external-url' && !b.storageKey
      const keyMissingProvider = !!b.storageKey && !b.storageProvider
      return (hasFileIntent && !hasAnyUsableSource) || providerMissingKey || keyMissingProvider
    }).slice(0, 20)

    const chunkBookIds = new Set(chunks.map((c) => c.bookId))
    const chunkRowsWithoutBook = chunks.filter((c) => !bookIds.has(c.bookId))
    const qMissingBook = questionRefs.filter((q) => q.bookId && !bookIds.has(q.bookId))
    const qMissingUnit = questionRefs.filter((q) => q.unitId && !unitIds.has(q.unitId))

    const orphanDrafts = drafts.filter((d) => {
      if (d.examType === 'UNIT') return !unitExamIds.has(d.examId)
      if (d.examType === 'PROGRAM') return !programExamIds.has(d.examId)
      return true
    })

    const totalLinkedStorageBytes = books.reduce((sum, b) => sum + bytes(b.size || 0), 0)
    const linkedR2Bytes = linkedR2.reduce((sum, b) => sum + bytes(b.size || 0), 0)
    const legacyBase64Bytes = legacyBase64.reduce((sum, b) => sum + approxBase64Bytes(b.data), 0)
    const chunkBytes = chunks.reduce((sum, c) => sum + bytes(c.size || 0), 0)
    const heavyDbFileRows = heavyDbFiles.reduce((sum, item) => sum + item.rows, 0)
    const heavyDbFileBytes = heavyDbFiles.reduce((sum, item) => sum + item.approxBytes, 0)
    const heavyDbFileHighRisk = heavyDbFiles.filter((item) => item.status === 'HIGH_RISK').length
    const heavyDbFileWarnings = heavyDbFiles.filter((item) => item.status === 'WARNING' || item.status === 'WATCH').length
    const externallyStoredAssignments = assignmentStorageRows.length
    const externallyStoredAssignmentBytes = assignmentStorageRows.reduce((sum, item) => sum + bytes(item.size || 0), 0)
    const externallyStoredDefenseRecordings = defenseRecordingRows.length
    const externallyStoredDefenseRecordingBytes = defenseRecordingRows.reduce((sum, item) => sum + bytes(item.recordingSize || 0), 0)

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      mode: 'READ_ONLY_REPORT',
      deletionEnabled: false,
      storageConfig: {
        s3Configured: Boolean(process.env.AACT_S3_ENDPOINT && process.env.AACT_S3_BUCKET && process.env.AACT_S3_ACCESS_KEY_ID && process.env.AACT_S3_SECRET_ACCESS_KEY),
        bucket: process.env.AACT_S3_BUCKET || null,
        publicBaseUrlConfigured: Boolean(process.env.AACT_STORAGE_PUBLIC_BASE_URL),
        note: 'هذا التقرير لا يحذف أي ملف ولا يعرض مفاتيح سرية. ملفات R2 غير المرتبطة لا يمكن الجزم بها من قاعدة البيانات فقط؛ التقرير يعرض الملفات المرتبطة والمشكلات المرصودة داخل قاعدة البيانات.',
      },
      summary: {
        booksTotal: books.length,
        linkedR2Objects: linkedR2.length,
        linkedLocalObjects: linkedLocal.length,
        externalLinks: externalLinks.length,
        legacyBase64Books: legacyBase64.length,
        linkedStorageBytes: totalLinkedStorageBytes,
        linkedR2Bytes,
        legacyBase64Bytes,
        uploadChunks: chunks.length,
        uploadChunkBytes: chunkBytes,
        heavyDbFileRows,
        heavyDbFileBytes,
        heavyDbFileHighRisk,
        heavyDbFileWarnings,
        externallyStoredAssignments,
        externallyStoredAssignmentBytes,
        externallyStoredDefenseRecordings,
        externallyStoredDefenseRecordingBytes,
        suspiciousBooks: suspiciousBooks.length,
        orphanUploadChunks: chunkRowsWithoutBook.length,
        questionBankBookRefsMissing: qMissingBook.length,
        questionBankUnitRefsMissing: qMissingUnit.length,
        examDraftsTotal: drafts.length,
        orphanExamDrafts: orphanDrafts.length,
        reviewExams: reviewExams.length,
      },
      recommendations: [
        suspiciousBooks.length ? 'راجع الكتب التي لها اسم/حجم ملف لكن لا تملك مصدر تخزين صالحاً.' : 'لا توجد كتب واضحة بلا مصدر تخزين صالح.',
        legacyBase64.length ? 'هناك كتب legacy ما زالت داخل قاعدة البيانات بصيغة Base64؛ لا يلزم حذفها الآن، لكن يمكن ترحيلها لاحقاً إلى R2.' : 'لا توجد كتب Base64 قديمة ظاهرة في التقرير.',
        heavyDbFileRows ? `يوجد ${heavyDbFileRows} سجل يحتوي ملفاً/تسجيلاً داخل Neon بحجم تقريبي ${Math.round(heavyDbFileBytes / 1024 / 1024)}MB؛ انقله إلى R2 قبل التوسع الكبير.` : 'لا توجد حالياً ملفات طلاب/تسجيلات/لقطات كبيرة داخل Neon حسب الحقول المفحوصة.',
        orphanDrafts.length ? 'توجد مسودات اختبار تشير إلى اختبار غير موجود؛ يمكن مراجعتها لاحقاً قبل أي تنظيف.' : 'لا توجد مسودات اختبار يتيمة ظاهرة.',
        qMissingBook.length || qMissingUnit.length ? 'توجد مراجع في بنك الأسئلة إلى كتاب/وحدة غير موجودة؛ الأسئلة تبقى محفوظة لكن مصدرها يحتاج مراجعة.' : 'مراجع بنك الأسئلة للكتب/الوحدات لا تظهر بها مشكلة واضحة.',
        'لا يُنصح بالحذف التلقائي حالياً. استخدم التقرير للمراقبة فقط، وأضف الحذف اليدوي لاحقاً إذا ظهرت أحجام كبيرة فعلاً.',
      ],
      samples: {
        suspiciousBooks: suspiciousBooks.map((b) => ({
          id: b.id,
          title: b.title,
          program: b.program?.titleAr || null,
          fileName: b.fileName,
          size: b.size,
          storageProvider: b.storageProvider,
          storageKey: b.storageKey,
          fileUrl: b.fileUrl,
          hasLegacyData: Boolean(b.data),
          hasLink: Boolean(b.link),
        })),
        orphanDrafts: orphanDrafts.slice(0, 20).map((d) => ({ id: d.id, examId: d.examId, examType: d.examType, updatedAt: d.updatedAt })),
        reviewExams: reviewExams.slice(0, 20).map((e) => ({ id: e.id, title: e.title, questions: e._count.questions, createdAt: e.createdAt })),
        heavyDbFiles,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('storage safety report error:', e)
    return NextResponse.json({ error: 'تعذر تحميل تقرير سلامة التخزين' }, { status: 500 })
  }
}
