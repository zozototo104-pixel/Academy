import { db } from '@/lib/db'
import { notify } from '@/lib/notify'

interface DefaultMicroCredentialSpec {
  suffix: string
  titlePrefix: string
  skillArea: string
  description: string
  learningOutcome: string
  minExamScore?: number
  requiresAppliedEvidence?: boolean
}

const DEFAULT_SPECS: DefaultMicroCredentialSpec[] = [
  {
    suffix: 'FOUNDATIONS',
    titlePrefix: 'شهادة مهارة في أساسيات',
    skillArea: 'أساسيات مهنية',
    description: 'وحدة مهارية قصيرة تثبت امتلاك الطالب أساسيات المجال ومفاهيمه المركزية داخل البرنامج.',
    learningOutcome: 'يفسر الطالب المفاهيم الأساسية ويطبقها على مواقف مهنية مباشرة.',
    minExamScore: 70,
  },
  {
    suffix: 'APPLIED_ANALYSIS',
    titlePrefix: 'شهادة مهارة في التحليل والتطبيق المهني في',
    skillArea: 'APPLIED_ANALYSIS',
    description: 'وحدة مهارية تثبت قدرة الطالب على تحليل حالات مهنية وربطها بالكتب المقررة ومخرجات التعلم.',
    learningOutcome: 'يحلل الطالب حالة تطبيقية ويقترح قراراً أو إجراءً مهنياً مبرراً.',
    minExamScore: 80,
  },
  {
    suffix: 'CAPSTONE_READY',
    titlePrefix: 'شهادة مهارة في المشروع أو البحث التطبيقي في',
    skillArea: 'CAPSTONE_PROJECT',
    description: 'وحدة مهارية مرتبطة بالواجبات التطبيقية أو بحث التخرج أو المناقشة النهائية.',
    learningOutcome: 'ينجز الطالب مخرجاً تطبيقياً قابلاً للتقييم والربط بنتائج البرنامج.',
    minExamScore: 70,
    requiresAppliedEvidence: true,
  },
]

function slugPart(value: string): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\u0600-\u06ff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'PROGRAM'
}

function stringifyEvidence(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

async function ensureDefaultProgramMicroCredentials(program: { id: string; titleAr: string; slug: string }) {
  const microCredentialStore = (db as any).microCredential
  if (!microCredentialStore?.upsert) return []

  const out = []
  for (const spec of DEFAULT_SPECS) {
    const badgeCode = `AACT-MC-${slugPart(program.slug)}-${spec.suffix}`
    const credential = await microCredentialStore.upsert({
      where: { badgeCode },
      create: {
        programId: program.id,
        titleAr: `${spec.titlePrefix} ${program.titleAr}`,
        titleEn: null,
        skillArea: spec.skillArea,
        description: spec.description,
        learningOutcome: spec.learningOutcome,
        criteria: {
          minExamScore: spec.minExamScore || 70,
          requiresAppliedEvidence: !!spec.requiresAppliedEvidence,
          automatic: true,
        },
        badgeCode,
        active: true,
      },
      update: {
        titleAr: `${spec.titlePrefix} ${program.titleAr}`,
        description: spec.description,
        learningOutcome: spec.learningOutcome,
        criteria: {
          minExamScore: spec.minExamScore || 70,
          requiresAppliedEvidence: !!spec.requiresAppliedEvidence,
          automatic: true,
        },
        active: true,
      },
    })
    out.push(credential)
  }
  return out
}

function criteriaOf(credential: any) {
  const raw = credential?.criteria
  if (!raw) return { minExamScore: 70, requiresAppliedEvidence: false }
  if (typeof raw === 'object') return raw as { minExamScore?: number; requiresAppliedEvidence?: boolean }
  try {
    return JSON.parse(String(raw)) as { minExamScore?: number; requiresAppliedEvidence?: boolean }
  } catch {
    return { minExamScore: 70, requiresAppliedEvidence: false }
  }
}

export async function awardEligibleMicroCredentials(userId: string) {
  const microCredentialStore = (db as any).microCredential
  const awardStore = (db as any).userMicroCredential
  if (!microCredentialStore?.findMany || !awardStore?.upsert) {
    return { earned: [], available: [], awardedNow: [] }
  }

  const enrollments = await db.enrollment.findMany({
    where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
    include: { program: { select: { id: true, titleAr: true, slug: true } } },
  })

  for (const en of enrollments) {
    await ensureDefaultProgramMicroCredentials(en.program)
  }

  const programIds = enrollments.map((e) => e.programId)
  if (programIds.length === 0) {
    const earned = await awardStore.findMany({ where: { userId, valid: true }, include: { microCredential: { include: { program: true } } }, orderBy: { issuedAt: 'desc' } })
    return { earned, available: [], awardedNow: [] }
  }

  const [credentials, programAttempts, assignmentSubmissions, theses, existingAwards] = await Promise.all([
    microCredentialStore.findMany({ where: { programId: { in: programIds }, active: true }, include: { program: true }, orderBy: [{ programId: 'asc' }, { createdAt: 'asc' }] }),
    db.programExamAttempt.findMany({
      where: { userId, passed: true, exam: { programId: { in: programIds } } },
      include: { exam: { select: { title: true, programId: true, semester: true } } },
      orderBy: { submittedAt: 'desc' },
    }),
    db.assignmentSubmission.findMany({
      where: { userId, status: 'GRADED', assignment: { programId: { in: programIds } } },
      include: { assignment: { select: { title: true, type: true, points: true, programId: true } } },
      orderBy: { gradedAt: 'desc' },
    }),
    db.thesisSubmission.findMany({
      where: { userId, passed: true },
      select: { id: true, title: true, resultScore: true, aiScore: true, admission: { select: { programId: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
    awardStore.findMany({ where: { userId, valid: true }, select: { microCredentialId: true } }),
  ])

  const existingIds = new Set(existingAwards.map((a: any) => a.microCredentialId))
  const awardedNow: any[] = []

  for (const credential of credentials) {
    if (existingIds.has(credential.id)) continue
    const criteria = criteriaOf(credential)
    const minExamScore = Number(criteria.minExamScore || 70)
    const bestExam = programAttempts
      .filter((a) => a.exam.programId === credential.programId && typeof a.score === 'number' && (a.score || 0) >= minExamScore)
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0]

    const appliedAssignment = assignmentSubmissions.find((a) =>
      a.assignment.programId === credential.programId &&
      typeof a.score === 'number' &&
      a.score >= Math.max(60, Math.round((a.assignment.points || 10) * 0.7))
    )
    const thesis = theses.find((t) => t.admission?.programId === credential.programId)

    const hasAppliedEvidence = !!appliedAssignment || !!thesis
    const eligible = !!bestExam && (!criteria.requiresAppliedEvidence || hasAppliedEvidence)
    if (!eligible) continue

    const award = await awardStore.upsert({
      where: { userId_microCredentialId: { userId, microCredentialId: credential.id } },
      create: {
        userId,
        microCredentialId: credential.id,
        source: criteria.requiresAppliedEvidence ? 'ASSIGNMENT' : 'EXAM',
        evidence: stringifyEvidence({
          reason: criteria.requiresAppliedEvidence
            ? 'استحقاق مهارة صغيرة بعد اجتياز امتحان موثق مع وجود واجب/بحث تطبيقي'
            : 'استحقاق مهارة صغيرة بعد اجتياز امتحان موثق بالدرجة المطلوبة',
          exam: bestExam ? { title: bestExam.exam.title, semester: bestExam.exam.semester, score: bestExam.score } : null,
          assignment: appliedAssignment ? { title: appliedAssignment.assignment.title, score: appliedAssignment.score } : null,
          thesis: thesis ? { title: thesis.title, score: thesis.resultScore ?? thesis.aiScore } : null,
        }),
        valid: true,
      },
      update: { valid: true, revokedAt: null, revokedReason: null },
      include: { microCredential: { include: { program: true } } },
    })
    awardedNow.push(award)
    existingIds.add(credential.id)

    await notify(userId, 'CERTIFICATE', 'حصلت على شهادة مهارة صغيرة', `تهانينا، مُنحت «${credential.titleAr}» ضمن برنامج ${credential.program.titleAr}.`, 'dashboard').catch(() => {})
  }

  const earned = await awardStore.findMany({ where: { userId, valid: true }, include: { microCredential: { include: { program: true } } }, orderBy: { issuedAt: 'desc' } })
  const earnedSet = new Set(earned.map((a: any) => a.microCredentialId))
  const available = credentials.filter((c: any) => !earnedSet.has(c.id))
  return { earned, available, awardedNow }
}
