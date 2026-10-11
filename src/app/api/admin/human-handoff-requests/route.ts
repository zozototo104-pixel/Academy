import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { decryptHumanHandoffPhoneForAdmin } from '@/lib/human-handoff'
import { redactDeep } from '@/lib/secret-crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await requireAdmin()
    const rows = await db.humanHandoffRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        source: true,
        sourceRef: true,
        name: true,
        email: true,
        phone: true,
        phoneMasked: true,
        phoneHash: true,
        phoneEncrypted: true,
        subject: true,
        message: true,
        status: true,
        assignedToId: true,
        assignedAt: true,
        contactedAt: true,
        closedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const requests = rows.map((row) => ({
      ...row,
      visitorPhone: decryptHumanHandoffPhoneForAdmin(row),
      visitorPhoneMasked: row.phoneMasked || row.phone || '',
      phoneEncrypted: undefined,
    }))
    return NextResponse.json(redactDeep({ ok: true, requests }))
  } catch (error: any) {
    const message = String(error?.message || error)
    if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json(redactDeep({ error: message }), { status: 500 })
  }
}
