import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ error: 'WhatsApp failures API was removed' }, { status: 410 })
}
