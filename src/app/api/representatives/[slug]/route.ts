import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEMO_REPRESENTATIVES, representativeLookupCandidates, serializeRepresentative } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  try {
    const row = await db.academyRepresentative.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
    })
    if (!row) {
      const demo = DEMO_REPRESENTATIVES.find((item) => item.slug === slug)
      if (demo) return NextResponse.json({ representative: demo, demo: true })
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
    return NextResponse.json({ representative: serializeRepresentative(row, originFrom(req), false), demo: false })
  } catch {
    const demo = DEMO_REPRESENTATIVES.find((item) => item.slug === slug)
    if (demo) return NextResponse.json({ representative: demo, demo: true })
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
}
