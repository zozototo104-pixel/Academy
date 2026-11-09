import { describe, test, expect, mock, beforeEach } from 'bun:test'

process.env.SCHOLARSHIP_ORGANIZATION_ENABLED = '1'

// In-memory mirrors of the organization-layer tables and the waiver ledger.
const definitions = new Map<string, any>()
const operations = new Map<string, any>()
const links = new Map<string, any>()
const waiverCodes: any[] = []
const payments = new Map<string, any>()
const admissions = new Map<string, any>()
const entries = new Map<string, any>()
const outboxRows: any[] = []
const notifications: any[] = []
let entrySeq = 0

function opMatches(op: any, where: any): boolean {
  if (!where) return true
  if (typeof where.status === 'string' && op.status !== where.status) return false
  if (where.status?.in && !where.status.in.includes(op.status)) return false
  if (typeof where.definitionId === 'string' && op.definitionId !== where.definitionId) return false
  if (where.definitionId?.in && !where.definitionId.in.includes(op.definitionId)) return false
  if (where.programId && op.programId !== where.programId) return false
  if (where.userId && op.userId !== where.userId) return false
  if (where.id?.in && !where.id.in.includes(op.id)) return false
  if (where.definition?.is?.coverage?.in) {
    const def = definitions.get(op.definitionId)
    if (!def || !where.definition.is.coverage.in.includes(def.coverage)) return false
  }
  return true
}

const db: any = {
  scholarshipDefinition: {
    findUnique: async ({ where }: any) => definitions.get(where.id) || null,
    findMany: async ({ where }: any) => [...definitions.values()].filter((def) => {
      if (where?.active !== undefined && def.active !== where.active) return false
      const programId = where?.programs?.some?.programId
      if (programId && !(def.programs || []).some((row: any) => row.programId === programId)) return false
      return true
    }).map((def) => ({ ...def })),
  },
  scholarshipGrantOperation: {
    findMany: async ({ where }: any) => [...operations.values()].filter((op) => opMatches(op, where)).map((op) => ({ ...op })),
    findFirst: async ({ where }: any) => {
      const rows = [...operations.values()].filter((op) => opMatches(op, where))
      if (where?.status === 'CANCELLED' || where?.status?.in?.includes('CANCELLED')) {
        rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      }
      return rows[0] ? { ...rows[0] } : null
    },
    updateMany: async ({ where, data }: any) => {
      const ids = where.id?.in || (where.id ? [where.id] : [])
      let count = 0
      for (const id of ids) {
        const op = operations.get(id)
        if (!op) continue
        if (typeof where.status === 'string' && where.status !== op.status) continue
        if (where.status?.in && !where.status.in.includes(op.status)) continue
        Object.assign(op, data, { updatedAt: new Date() })
        count++
      }
      return { count }
    },
  },
  scholarshipGrantLink: {
    findMany: async ({ where }: any) => [...links.values()].filter((link) =>
      !where?.operationId || (typeof where.operationId === 'string'
        ? link.operationId === where.operationId
        : where.operationId.in?.includes(link.operationId))
    ).map((link) => ({ ...link })),
  },
  paymentWaiverCode: {
    findMany: async ({ where }: any) => waiverCodes.filter((row) => {
      if (where?.id?.in && !where.id.in.includes(row.id)) return false
      if (where?.paymentId?.in && !where.paymentId.in.includes(row.paymentId)) return false
      if (where?.waiverType?.in && !where.waiverType.in.includes(row.waiverType)) return false
      const ownership = where?.payment?.is?.OR
      if (ownership) {
        const payment = payments.get(row.paymentId)
        if (!payment) return false
        if (!ownership.some((rule: any) =>
          (rule.userId && payment.userId === rule.userId)
          || (rule.admission?.is?.userId && payment.admission?.userId === rule.admission.is.userId))) return false
      }
      return true
    }).map((row) => ({ ...row })),
  },
  admissionApplication: {
    findUnique: async ({ where }: any) => admissions.get(where.id) || null,
  },
  scholarshipWaitlistEntry: {
    findUnique: async ({ where }: any) => {
      const key = where.definitionId_userId
      const row = [...entries.values()].find((e) => e.definitionId === key.definitionId && e.userId === key.userId)
      return row ? { ...row } : null
    },
    create: async ({ data }: any) => {
      const row = { ...data, id: 'entry-' + (++entrySeq), createdAt: new Date(), updatedAt: new Date() }
      entries.set(row.id, row)
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = entries.get(where.id)
      if (!row) throw new Error('ENTRY_NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      return { ...row }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const row of entries.values()) {
        if (where.userId && row.userId !== where.userId) continue
        if (where.definitionId && row.definitionId !== where.definitionId) continue
        if (where.programId && row.programId !== where.programId) continue
        if (where.status?.in && !where.status.in.includes(row.status)) continue
        Object.assign(row, data, { updatedAt: new Date() })
        count++
      }
      return { count }
    },
    findMany: async ({ where }: any) => [...entries.values()]
      .filter((row) => (!where?.definitionId || row.definitionId === where.definitionId)
        && (!where?.programId || row.programId === where.programId)
        && (!where?.status?.in || where.status.in.includes(row.status)))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((row) => ({ ...row })),
  },
  notificationOutbox: {
    create: async ({ data }: any) => { outboxRows.push(data); return data },
  },
  notification: {
    create: async ({ data }: any) => { notifications.push(data); return data },
  },
  user: {
    findUnique: async ({ where }: any) => ({ id: where.id, email: where.id + '@example.com' }),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ getCurrentUser: async () => null }))

const {
  joinScholarshipWaitlist, leaveScholarshipWaitlist, notifyWaitlistForFreeSeats,
  releaseStaleGrantOperations, countOccupiedSeats, WaitlistError,
} = await import('../../src/lib/scholarship-waitlist')
const { GET: availabilityGET } = await import('../../src/app/api/payments/scholarship-availability/route')
const { NextRequest } = await import('next/server')

const DEF = 'def-campaign'
function seedCampaign(seats: number | null, overrides: Record<string, any> = {}) {
  definitions.set(DEF, {
    id: DEF, title: 'منحة التفوق', scope: 'PROGRAM', coverage: 'TUITION',
    active: true, startsAt: null, endsAt: null,
    programs: [{ programId: 'program-A', seats }],
    ...overrides,
  })
}
function seedAdmission(id: string, userId: string) {
  admissions.set(id, { id, userId, programId: 'program-A' })
  payments.set('pay-' + id, { id: 'pay-' + id, userId, admission: { userId } })
}
function seedOccupyingOperation(opId: string, userId: string, code: Record<string, any> = { status: 'ISSUED', expiresAt: new Date(Date.now() + 60_000) }) {
  operations.set(opId, {
    id: opId, definitionId: DEF, programId: 'program-A', userId,
    admissionId: 'adm-' + userId, status: 'ISSUED', updatedAt: new Date(),
  })
  const waiverId = opId + '-code'
  waiverCodes.push({ id: waiverId, paymentId: 'pay-adm-' + userId, waiverType: 'PARTIAL_TUITION', ...code })
  links.set('link-' + opId, { id: 'link-' + opId, operationId: opId, definitionId: DEF, waiverCodeId: waiverId, paymentId: 'pay-adm-' + userId })
}
async function seedWaitingEntry(userId: string, createdAt: Date) {
  seedAdmission('adm-' + userId, userId)
  const row = { id: 'entry-' + (++entrySeq), definitionId: DEF, userId, admissionId: 'adm-' + userId, programId: 'program-A', status: 'WAITING', releaseKey: null, createdAt, updatedAt: createdAt }
  entries.set(row.id, row)
  return row
}

beforeEach(() => {
  definitions.clear(); operations.clear(); links.clear(); waiverCodes.length = 0
  payments.clear(); admissions.clear(); entries.clear(); outboxRows.length = 0; notifications.length = 0
})

describe('scholarship waitlist', () => {
  test('a student joins only when the campaign is full, and joining reserves nothing', async () => {
    seedCampaign(1)
    seedAdmission('adm-joiner', 'joiner')
    seedOccupyingOperation('op-holder', 'holder')
    const entry = await joinScholarshipWaitlist(db, { userId: 'joiner', admissionId: 'adm-joiner', definitionId: DEF })
    expect(entry.status).toBe('WAITING')
    expect(operations.get('op-holder')?.status).toBe('ISSUED')
    // joining again is idempotent: same entry, still WAITING
    const again = await joinScholarshipWaitlist(db, { userId: 'joiner', admissionId: 'adm-joiner', definitionId: DEF })
    expect(again.id).toBe(entry.id)
  })

  test('joining is refused while a seat is still available', async () => {
    seedCampaign(2)
    seedAdmission('adm-early', 'early')
    seedOccupyingOperation('op-one', 'someone')
    await expect(joinScholarshipWaitlist(db, { userId: 'early', admissionId: 'adm-early', definitionId: DEF }))
      .rejects.toMatchObject({ code: 'WAITLIST_SEATS_AVAILABLE' })
  })

  test('a scholarship holder cannot join and is pruned from other waitlists', async () => {
    seedCampaign(1)
    seedAdmission('adm-holder', 'holder2')
    seedOccupyingOperation('op-full', 'someone-else')
    // holder2 already owns an approved tuition scholarship on his own payment
    waiverCodes.push({ id: 'approved-own', paymentId: 'pay-adm-holder', waiverType: 'FULL_SCHOLARSHIP', status: 'APPROVED' })
    const stale = await seedWaitingEntry('holder2', new Date())
    stale.definitionId = 'def-other'
    entries.set(stale.id, stale)
    await expect(joinScholarshipWaitlist(db, { userId: 'holder2', admissionId: 'adm-holder', definitionId: DEF }))
      .rejects.toMatchObject({ code: 'WAITLIST_ALREADY_HOLDS_SCHOLARSHIP' })
    expect(entries.get(stale.id)?.status).toBe('FULFILLED')
  })

  test('when a seat frees, only the head of the queue is invited, once per opening', async () => {
    seedCampaign(1)
    seedOccupyingOperation('op-seat', 'leaver')
    const first = await seedWaitingEntry('first', new Date(Date.now() - 2000))
    const second = await seedWaitingEntry('second', new Date(Date.now() - 1000))
    operations.get('op-seat')!.status = 'CANCELLED'
    const notified = await notifyWaitlistForFreeSeats(db, DEF, 'program-A')
    expect(notified).toBe(1)
    expect(entries.get(first.id)?.status).toBe('NOTIFIED')
    expect(entries.get(first.id)?.releaseKey).toBe('rel:op-seat')
    expect(entries.get(second.id)?.status).toBe('WAITING')
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0].idempotencyKey).toBe('waitlist-opening:' + first.id + ':rel:op-seat')
    expect(notifications).toHaveLength(1)
    // same opening again: nobody new is invited
    expect(await notifyWaitlistForFreeSeats(db, DEF, 'program-A')).toBe(0)
    expect(outboxRows).toHaveLength(1)
  })

  test('a freed pair of seats invites the first two in registration order', async () => {
    seedCampaign(2)
    const a = await seedWaitingEntry('w-a', new Date(Date.now() - 3000))
    const b = await seedWaitingEntry('w-b', new Date(Date.now() - 2000))
    const c = await seedWaitingEntry('w-c', new Date(Date.now() - 1000))
    expect(await notifyWaitlistForFreeSeats(db, DEF, 'program-A')).toBe(2)
    expect(entries.get(a.id)?.status).toBe('NOTIFIED')
    expect(entries.get(b.id)?.status).toBe('NOTIFIED')
    expect(entries.get(c.id)?.status).toBe('WAITING')
  })

  test('a holder at the head is dropped and the next in line is invited instead', async () => {
    seedCampaign(1)
    const head = await seedWaitingEntry('lucky', new Date(Date.now() - 2000))
    const next = await seedWaitingEntry('next', new Date(Date.now() - 1000))
    seedAdmission('adm-lucky', 'lucky')
    waiverCodes.push({ id: 'lucky-code', paymentId: 'pay-adm-lucky', waiverType: 'PARTIAL_TUITION', status: 'APPROVED' })
    expect(await notifyWaitlistForFreeSeats(db, DEF, 'program-A')).toBe(1)
    expect(entries.get(head.id)?.status).toBe('FULFILLED')
    expect(entries.get(next.id)?.status).toBe('NOTIFIED')
  })

  test('closing the campaign ends its waitlist without invitations', async () => {
    seedCampaign(1, { active: false })
    const entry = await seedWaitingEntry('hopeful', new Date())
    expect(await notifyWaitlistForFreeSeats(db, DEF, 'program-A')).toBe(0)
    expect(entries.get(entry.id)?.status).toBe('LEFT')
    expect(outboxRows).toHaveLength(0)
  })

  test('leaving and rejoining goes to the back of the queue', async () => {
    seedCampaign(1)
    seedOccupyingOperation('op-block', 'blocker')
    seedAdmission('adm-back', 'back')
    const entry = await joinScholarshipWaitlist(db, { userId: 'back', admissionId: 'adm-back', definitionId: DEF })
    const joinedAt = new Date(entry.createdAt).getTime()
    await leaveScholarshipWaitlist(db, { userId: 'back', definitionId: DEF })
    expect(entries.get(entry.id)?.status).toBe('LEFT')
    const rejoined = await joinScholarshipWaitlist(db, { userId: 'back', admissionId: 'adm-back', definitionId: DEF })
    expect(rejoined.status).toBe('WAITING')
    expect(new Date(rejoined.createdAt).getTime()).toBeGreaterThanOrEqual(joinedAt)
  })

  test('general-scope grants stay admin-only: never listed for students (owner decision 2026-11-09)', async () => {
    seedCampaign(3)
    definitions.set('def-general', {
      id: 'def-general', title: 'منحة عامة', scope: 'GENERAL', coverage: 'TUITION',
      active: true, startsAt: null, endsAt: null, programs: [],
    })
    const response = await availabilityGET(new NextRequest('http://localhost/api/payments/scholarship-availability?programId=program-A'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.enabled).toBe(true)
    expect(body.campaigns.map((c: any) => c.definitionId)).toEqual([DEF])
    // And while the organization is disabled, nothing is listed at all.
    delete process.env.SCHOLARSHIP_ORGANIZATION_ENABLED
    const off = await availabilityGET(new NextRequest('http://localhost/api/payments/scholarship-availability?programId=program-A'))
    expect((await off.json()).enabled).toBe(false)
    process.env.SCHOLARSHIP_ORGANIZATION_ENABLED = '1'
  })

  test('a resend gap cannot release the seat: a live unlinked replacement on the same invoice keeps the operation alive', async () => {
    seedCampaign(1)
    // The engine has just resent: the linked code is CANCELLED and the
    // replacement exists on the same invoice but is not linked yet.
    seedOccupyingOperation('op-resent', 'resent-user', { status: 'CANCELLED' })
    waiverCodes.push({ id: 'replacement-code', paymentId: 'pay-adm-resent-user', waiverType: 'PARTIAL_TUITION', status: 'ISSUED', expiresAt: new Date(Date.now() + 60_000) })
    const released = await releaseStaleGrantOperations(db, {})
    expect(released).toEqual([])
    expect(operations.get('op-resent')?.status).toBe('ISSUED')
    expect(await countOccupiedSeats(db, DEF, 'program-A')).toBe(1)
    // Once the replacement is dead too, the release works again — the
    // guard delays a release, it never disables it.
    const replacement = waiverCodes.find((row) => row.id === 'replacement-code')!
    replacement.status = 'CANCELLED'
    const releasedAfter = await releaseStaleGrantOperations(db, {})
    expect(releasedAfter.map((op: any) => op.id)).toEqual(['op-resent'])
    expect(operations.get('op-resent')?.status).toBe('CANCELLED')
  })

  test('expiry release closes a fully expired reservation and frees its seat for the waitlist', async () => {
    seedCampaign(1)
    seedOccupyingOperation('op-dead', 'gone', { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) })
    const waiting = await seedWaitingEntry('patient', new Date())
    const released = await releaseStaleGrantOperations(db, {})
    expect(released.map((op: any) => op.id)).toEqual(['op-dead'])
    expect(operations.get('op-dead')?.status).toBe('CANCELLED')
    expect(await notifyWaitlistForFreeSeats(db, DEF, 'program-A')).toBe(1)
    expect(entries.get(waiting.id)?.status).toBe('NOTIFIED')
  })
})
