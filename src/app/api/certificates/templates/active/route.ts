import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

function serializeTemplate(t: any) {
  return t ? {
    id: t.id,
    name: t.name,
    certificateType: t.certificateType,
    layoutJson: t.layoutJson || null,
    imageUrl: `/api/certificates/templates/${t.id}/image`,
  } : null
}

export async function GET(req: NextRequest) {
  const type = String(req.nextUrl.searchParams.get('type') || 'PROGRAM_COMPLETION').trim() || 'PROGRAM_COMPLETION'
  const template = await db.certificateTemplate.findFirst({
    where: { certificateType: type, active: true },
    orderBy: { createdAt: 'desc' },
  }) || await db.certificateTemplate.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ template: serializeTemplate(template) }, { headers: { 'Cache-Control': 'no-store' } })
}
