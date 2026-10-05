import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getAccreditationProfileForAdmin, serializeAccreditationDocument } from '@/lib/accreditation'

const patchSchema = z.object({
  title: z.string().trim().min(1).max(220).optional(),
  description: z.string().trim().max(1200).optional(),
  verifyUrl: z.string().trim().url().or(z.literal('')).optional(),
  kind: z.enum(['LICENSE', 'PARTNERSHIP', 'OTHER']).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
})

function revalidateAccreditationSurfaces() {
  for (const path of ['/accreditation', '/', '/sitemap.xml']) {
    try { revalidatePath(path) } catch (error) { console.warn('accreditation document revalidate failed:', path, error) }
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const payload = patchSchema.parse(body)
    const doc = await db.accreditationDocument.update({
      where: { id },
      data: {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description || null } : {}),
        ...(payload.verifyUrl !== undefined ? { verifyUrl: payload.verifyUrl || null } : {}),
        ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
        ...(payload.active !== undefined ? { active: payload.active } : {}),
        ...(payload.displayOrder !== undefined ? { displayOrder: payload.displayOrder } : {}),
      },
    })
    revalidateAccreditationSurfaces()
    await audit(user, 'UPDATE_ACCREDITATION_DOCUMENT', 'AccreditationDocument', doc.id, `حدّث وثيقة اعتماد: ${doc.title}`)
    return NextResponse.json({ ok: true, document: serializeAccreditationDocument(doc), profile: await getAccreditationProfileForAdmin() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الوثيقة' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const { id } = await params
    const doc = await db.accreditationDocument.delete({ where: { id } })
    revalidateAccreditationSurfaces()
    await audit(user, 'DELETE_ACCREDITATION_DOCUMENT', 'AccreditationDocument', doc.id, `حذف وثيقة اعتماد من السجل: ${doc.title}`)
    return NextResponse.json({ ok: true, profile: await getAccreditationProfileForAdmin() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'تعذر حذف الوثيقة' }, { status: 400 })
  }
}
