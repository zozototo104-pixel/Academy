import { NextRequest, NextResponse } from 'next/server'
import { claimAiHealthRun } from '@/lib/ai-health'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { redactDeep } from '@/lib/secret-crypto'
import { textAiCheckAllModelHealth } from '@/lib/text-ai'
import { releaseStaleGrantOperations, notifyWaitlistForFreeSeats, scholarshipOrganizationEnabled } from '@/lib/scholarship-waitlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const claimed = await claimAiHealthRun()
  if (!claimed) return NextResponse.json(redactDeep({ ok: true, skipped: true }))
  const expired = await db.paymentWaiverCode.updateMany({
    where: { status: 'ISSUED', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  })
  if (expired.count > 0) {
    await audit({ name: 'cron' }, 'PAYMENT_WAIVER_CODES_EXPIRED', 'PaymentWaiverCode', null, `expired=${expired.count}`)
  }
  // Scholarship organization upkeep (organization-layer tables only):
  // close reservations whose codes have all expired, then invite the head
  // of any waitlist whose campaign now has a free seat. Failure-isolated:
  // it must never break the health check below.
  try {
    if (scholarshipOrganizationEnabled()) {
      await releaseStaleGrantOperations(db, {})
      const waiting = await db.scholarshipWaitlistEntry.findMany({
        where: { status: { in: ['WAITING', 'NOTIFIED'] } },
        select: { definitionId: true, programId: true },
      })
      const pools = new Map<string, { definitionId: string; programId: string }>()
      for (const entry of waiting) {
        pools.set(entry.definitionId + ':' + entry.programId, { definitionId: entry.definitionId, programId: entry.programId })
      }
      for (const pool of pools.values()) {
        await notifyWaitlistForFreeSeats(db, pool.definitionId, pool.programId)
      }
    }
  } catch (e) {
    console.error('scholarship organization sweep failed', e)
  }
  const result = await textAiCheckAllModelHealth({ maxMs: 40_000 })
  return NextResponse.json(redactDeep({ ok: true, expiredWaiverCodes: expired.count, ...result }))
}
