import { db } from '@/lib/db'
import { notify } from '@/lib/notify'
import { enqueueOutbox } from '@/lib/outbox'

// Scholarship organization layer: seat reservations, expiry release and
// campaign waitlists. This module never touches the waiver ledger itself;
// it only reads waiver codes to judge liveness and moves the layer's own
// operation / waitlist rows.

export function scholarshipOrganizationEnabled(): boolean {
  return process.env.SCHOLARSHIP_ORGANIZATION_ENABLED === '1'
}

export const GRANT_OCCUPYING_STATUSES = ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] as const

// A waiver code is live when it was approved (the seat is consumed for
// good), or it is ISSUED/VERIFIED and not past its expiry — the same rule
// the organized eligibility checks apply to legacy codes.
export function isLiveWaiverCode(code: any, now = Date.now()): boolean {
  if (!code) return false
  if (code.status === 'APPROVED') return true
  if (code.status !== 'ISSUED' && code.status !== 'VERIFIED') return false
  return !code.expiresAt || new Date(code.expiresAt).getTime() > now
}

export type StaleScope = {
  definitionId?: string
  definitionIds?: string[]
  programId?: string
  userId?: string
  operationIds?: string[]
}

// ISSUED operations whose linked codes are ALL dead (expired or terminal).
// Pure derivation: nothing is written. An operation with no links is never
// stale — it belongs to the incomplete-operation review path, not expiry.
export async function findStaleGrantOperations(client: any, scope: StaleScope) {
  const where: Record<string, any> = { status: 'ISSUED' }
  if (scope.definitionId) where.definitionId = scope.definitionId
  if (scope.definitionIds) where.definitionId = { in: scope.definitionIds }
  if (scope.programId) where.programId = scope.programId
  if (scope.userId) where.userId = scope.userId
  if (scope.operationIds) where.id = { in: scope.operationIds }
  const operations = await client.scholarshipGrantOperation.findMany({
    where,
    select: { id: true, definitionId: true, programId: true, userId: true },
  })
  if (!operations.length) return []
  const links = await client.scholarshipGrantLink.findMany({
    where: { operationId: { in: operations.map((op: any) => op.id) } },
    select: { operationId: true, waiverCodeId: true, paymentId: true },
  })
  if (!links.length) return []
  const codes = await client.paymentWaiverCode.findMany({
    where: { id: { in: links.map((link: any) => link.waiverCodeId) } },
    select: { id: true, status: true, expiresAt: true },
  })
  const codeById = new Map(codes.map((code: any) => [code.id, code]))
  const linkedOperations = new Set<string>()
  const liveOperations = new Set<string>()
  const paymentIdsByOperation = new Map<string, Set<string>>()
  for (const link of links) {
    linkedOperations.add(link.operationId)
    if (isLiveWaiverCode(codeById.get(link.waiverCodeId))) liveOperations.add(link.operationId)
    if (link.paymentId) {
      if (!paymentIdsByOperation.has(link.operationId)) paymentIdsByOperation.set(link.operationId, new Set())
      paymentIdsByOperation.get(link.operationId)!.add(link.paymentId)
    }
  }
  // A resend replaces the code inside the engine BEFORE the route links the
  // replacement to this operation. During that gap the operation's linked
  // code is dead while a live replacement already exists on the same
  // invoice — the operation must not read as stale, or its seat is released
  // under a live code and the approval guard then refuses it forever. Any
  // live code on any of the operation's invoices (linked or not yet linked)
  // keeps the operation alive; the bias is always toward releasing late,
  // never toward releasing under a live code.
  const paymentIds = [...new Set(links.map((link: any) => link.paymentId).filter(Boolean))]
  if (paymentIds.length) {
    const paymentCodes = await client.paymentWaiverCode.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true, status: true, expiresAt: true },
    })
    const livePayments = new Set(
      paymentCodes.filter((code: any) => isLiveWaiverCode(code)).map((code: any) => code.paymentId),
    )
    for (const [operationId, ids] of paymentIdsByOperation) {
      if ([...ids].some((paymentId) => livePayments.has(paymentId))) liveOperations.add(operationId)
    }
  }
  return operations.filter((op: any) => linkedOperations.has(op.id) && !liveOperations.has(op.id))
}

// Close every stale reservation in scope as CANCELLED, which returns its
// seat to the campaign pool and lifts the one-scholarship hold. Status-
// guarded, so concurrent closers cannot double-apply it.
export async function releaseStaleGrantOperations(client: any, scope: StaleScope) {
  const stale = await findStaleGrantOperations(client, scope)
  if (!stale.length) return []
  const closed = await client.scholarshipGrantOperation.updateMany({
    where: { id: { in: stale.map((op: any) => op.id) }, status: 'ISSUED' },
    data: { status: 'CANCELLED' },
  })
  return closed.count ? stale : []
}

// Seats currently held for one definition+program, discounting reservations
// that expiry has already ended (read-only; nothing is closed here).
export async function countOccupiedSeats(client: any, definitionId: string, programId: string): Promise<number> {
  const operations = await client.scholarshipGrantOperation.findMany({
    where: { definitionId, programId, status: { in: [...GRANT_OCCUPYING_STATUSES] } },
    select: { id: true },
  })
  if (!operations.length) return 0
  const stale = await findStaleGrantOperations(client, {
    operationIds: operations.map((op: any) => op.id),
  })
  return operations.length - stale.length
}

// The absolute one-scholarship rule, system-wide for one verified userId:
// an approved tuition waiver, a live tuition code, or an occupying
// organized operation on a tuition-covering definition — any program.
export async function userHoldsScholarship(client: any, userId: string): Promise<boolean> {
  const operation = await client.scholarshipGrantOperation.findFirst({
    where: {
      userId,
      status: { in: [...GRANT_OCCUPYING_STATUSES] },
      definition: { is: { coverage: { in: ['TUITION', 'BOTH'] } } },
    },
    select: { id: true },
  })
  if (operation) {
    const stale = await findStaleGrantOperations(client, { operationIds: [operation.id] })
    if (!stale.length) return true
  }
  const codes = await client.paymentWaiverCode.findMany({
    where: {
      waiverType: { in: ['PARTIAL_TUITION', 'FULL_SCHOLARSHIP'] },
      payment: { is: { OR: [{ userId }, { admission: { is: { userId } } }] } },
    },
    select: { id: true, status: true, expiresAt: true },
  })
  return codes.some((code: any) => isLiveWaiverCode(code))
}

// Anyone who now holds a scholarship leaves every waitlist automatically.
export async function pruneWaitlistForHolder(client: any, userId: string): Promise<void> {
  if (!(await userHoldsScholarship(client, userId))) return
  await client.scholarshipWaitlistEntry.updateMany({
    where: { userId, status: { in: ['WAITING', 'NOTIFIED'] } },
    data: { status: 'FULFILLED' },
  })
}

export class WaitlistError extends Error {
  status: number
  code: string
  constructor(message: string, status = 409, code = 'WAITLIST_ERROR') {
    super(message)
    this.status = status
    this.code = code
  }
}

async function loadCampaignForProgram(client: any, definitionId: string, programId: string) {
  const definition = await client.scholarshipDefinition.findUnique({
    where: { id: definitionId },
    include: { programs: { select: { programId: true, seats: true } } },
  })
  if (!definition) throw new WaitlistError('تعريف المنحة غير موجود', 404, 'WAITLIST_DEFINITION_MISSING')
  const program = (definition.programs || []).find((item: any) => item.programId === programId)
  if (!program) throw new WaitlistError('هذا البرنامج غير مشمول بهذه المنحة', 409, 'WAITLIST_PROGRAM_NOT_INCLUDED')
  return { definition, program }
}

function campaignOpen(definition: any): boolean {
  if (!definition.active) return false
  const now = Date.now()
  if (definition.startsAt && new Date(definition.startsAt).getTime() > now) return false
  if (definition.endsAt && new Date(definition.endsAt).getTime() < now) return false
  return true
}

// Record a student's interest in a campaign whose seats are currently full.
// Joining reserves nothing: a seat is only ever reserved at code issuance.
export async function joinScholarshipWaitlist(
  client: any,
  args: { userId: string; admissionId: string; definitionId: string },
) {
  if (!scholarshipOrganizationEnabled()) {
    throw new WaitlistError('تنظيم المنح غير مفعّل بعد', 503, 'GRANT_ORGANIZATION_NOT_READY')
  }
  const admission = await client.admissionApplication.findUnique({
    where: { id: args.admissionId },
    select: { id: true, userId: true, programId: true },
  })
  if (!admission || admission.userId !== args.userId || !admission.programId) {
    throw new WaitlistError('طلب القبول غير مرتبط بحسابك أو بتخصص محدد', 403, 'WAITLIST_ADMISSION_MISMATCH')
  }
  const { definition, program } = await loadCampaignForProgram(client, args.definitionId, admission.programId)
  if (!campaignOpen(definition)) {
    throw new WaitlistError('هذه المنحة مغلقة حاليًا ولا تقبل الانضمام لقائمة الانتظار', 409, 'WAITLIST_CAMPAIGN_CLOSED')
  }
  if (program.seats == null) {
    throw new WaitlistError('هذه المنحة بلا سقف مقاعد؛ لا حاجة لقائمة انتظار', 409, 'WAITLIST_UNCAPPED')
  }
  await pruneWaitlistForHolder(client, args.userId)
  if (await userHoldsScholarship(client, args.userId)) {
    throw new WaitlistError('لديك منحة دراسية سارية؛ لا يمكن الانضمام لقائمة الانتظار', 409, 'WAITLIST_ALREADY_HOLDS_SCHOLARSHIP')
  }
  const occupied = await countOccupiedSeats(client, args.definitionId, admission.programId)
  if (occupied < program.seats) {
    throw new WaitlistError('توجد مقاعد متاحة في هذه المنحة؛ الإصدار يتم عبر الإدارة مباشرة دون قائمة انتظار', 409, 'WAITLIST_SEATS_AVAILABLE')
  }
  const existing = await client.scholarshipWaitlistEntry.findUnique({
    where: { definitionId_userId: { definitionId: args.definitionId, userId: args.userId } },
  })
  if (existing && (existing.status === 'WAITING' || existing.status === 'NOTIFIED')) return existing
  if (existing && existing.status === 'FULFILLED') {
    throw new WaitlistError('لديك منحة دراسية سارية؛ لا يمكن الانضمام لقائمة الانتظار', 409, 'WAITLIST_ALREADY_HOLDS_SCHOLARSHIP')
  }
  if (existing) {
    // Rejoining after leaving goes to the back of the queue.
    return client.scholarshipWaitlistEntry.update({
      where: { id: existing.id },
      data: { status: 'WAITING', releaseKey: null, admissionId: args.admissionId, programId: admission.programId, createdAt: new Date() },
    })
  }
  return client.scholarshipWaitlistEntry.create({
    data: {
      definitionId: args.definitionId, userId: args.userId,
      admissionId: args.admissionId, programId: admission.programId, status: 'WAITING',
    },
  })
}

export async function leaveScholarshipWaitlist(client: any, args: { userId: string; definitionId: string }) {
  const existing = await client.scholarshipWaitlistEntry.findUnique({
    where: { definitionId_userId: { definitionId: args.definitionId, userId: args.userId } },
  })
  if (!existing || (existing.status !== 'WAITING' && existing.status !== 'NOTIFIED')) return existing
  return client.scholarshipWaitlistEntry.update({
    where: { id: existing.id },
    data: { status: 'LEFT' },
  })
}

// When seats are free in an open campaign, invite the head of its waitlist:
// in registration order, one batch per opening, sized to the free seats.
// The invitation promises nothing — a seat is reserved only when the
// administration issues a code, and priority goes to whoever acts first.
// Dedupe is per opening (releaseKey) and per message (outbox key); missing
// an opening keeps the student's place for the next one.
export async function notifyWaitlistForFreeSeats(
  client: any,
  definitionId: string,
  programId: string,
): Promise<number> {
  if (!scholarshipOrganizationEnabled()) return 0
  const { definition, program } = await loadCampaignForProgram(client, definitionId, programId)
    .catch(() => ({ definition: null, program: null }))
  if (!definition || !program) return 0
  if (!campaignOpen(definition)) {
    await client.scholarshipWaitlistEntry.updateMany({
      where: { definitionId, programId, status: { in: ['WAITING', 'NOTIFIED'] } },
      data: { status: 'LEFT' },
    })
    return 0
  }
  if (program.seats == null) return 0
  const occupied = await countOccupiedSeats(client, definitionId, programId)
  const free = program.seats - occupied
  if (free <= 0) return 0
  const entries = await client.scholarshipWaitlistEntry.findMany({
    where: { definitionId, programId, status: { in: ['WAITING', 'NOTIFIED'] } },
    orderBy: { createdAt: 'asc' },
  })
  if (!entries.length) return 0
  const latestRelease = await client.scholarshipGrantOperation.findFirst({
    where: { definitionId, programId, status: 'CANCELLED' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  })
  const openingKey = latestRelease ? 'rel:' + latestRelease.id : 'open:' + definitionId + ':' + programId
  const alreadyInvited = entries.filter((entry: any) => entry.releaseKey === openingKey).length
  let slots = free - alreadyInvited
  if (slots <= 0) return 0
  let notified = 0
  for (const entry of entries) {
    if (slots <= 0) break
    if (entry.releaseKey === openingKey) continue
    if (await userHoldsScholarship(client, entry.userId)) {
      await client.scholarshipWaitlistEntry.update({
        where: { id: entry.id },
        data: { status: 'FULFILLED' },
      })
      continue
    }
    // Claim the entry BEFORE notifying: this guarded update is the
    // concurrency lock for the opening. Two callers racing the same
    // release (a cancellation hook and the hourly sweep, or two
    // cancellations) read the same waiting entries, but only the one
    // whose claim lands notifies — the loser sees count 0 and skips, so
    // no student is ever invited twice for the same opening.
    const claim = await client.scholarshipWaitlistEntry.updateMany({
      where: {
        id: entry.id,
        status: { in: ['WAITING', 'NOTIFIED'] },
        OR: [{ releaseKey: null }, { releaseKey: { not: openingKey } }],
      },
      data: { status: 'NOTIFIED', releaseKey: openingKey },
    })
    if (!claim.count) continue
    const title = 'مقعد متاح في منحة ' + definition.title
    const body = 'صار في مقعد مفتوح في منحة «' + definition.title + '» المشمول بها برنامجك. هذا تنبيه وليس حجزًا: المقعد يُحجز فقط عند إصدار كود المنحة من الإدارة، والأولوية لمن يبادر أولًا. تابع من لوحة الطالب أو تواصل مع الإدارة.'
    await notify(entry.userId, 'SCHOLARSHIP_WAITLIST_OPENING', title, body, '/dashboard')
    await enqueueOutbox(client, {
      key: 'waitlist-opening:' + entry.id + ':' + openingKey,
      kind: 'SCHOLARSHIP_WAITLIST_OPENING',
      recipientUserId: entry.userId,
      title,
      body,
      link: '/dashboard',
    }).catch(() => {})
    slots--
    notified++
  }
  return notified
}
