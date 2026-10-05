import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

function serializeTemplate(t: any) {
  return {
    id: t.id,
    name: t.name,
    certificateType: t.certificateType,
    active: t.active,
    fileName: t.fileName,
    mimeType: t.mimeType,
    fileSize: t.fileSize,
    layoutJson: t.layoutJson || null,
    imageUrl: `/api/certificates/templates/${t.id}/image`,
    createdAt: t.createdAt,
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const data: any = {}
    if (typeof body.name === 'string') data.name = body.name.trim().slice(0, 180)
    if (typeof body.certificateType === 'string') data.certificateType = body.certificateType.trim() || 'PROGRAM_COMPLETION'
    if (typeof body.active === 'boolean') data.active = body.active
    if (body.layoutJson && typeof body.layoutJson === 'object') data.layoutJson = body.layoutJson
    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'لا توجد تغييرات' }, { status: 400 })
    const template = await db.certificateTemplate.update({ where: { id }, data })
    await audit(admin, 'UPDATE_CERTIFICATE_TEMPLATE', 'CertificateTemplate', template.id, `${template.name} — ${template.active ? 'نشط' : 'معطل'}`)
    return NextResponse.json({ ok: true, template: serializeTemplate(template) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'تعذر تحديث قالب الشهادة' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const template = await db.certificateTemplate.delete({ where: { id } })
    await audit(admin, 'DELETE_CERTIFICATE_TEMPLATE', 'CertificateTemplate', template.id, template.name)
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'تعذر حذف قالب الشهادة' }, { status: 400 })
  }
}
