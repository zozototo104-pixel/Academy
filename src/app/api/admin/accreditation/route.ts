import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { ensureAccreditationProfile, getAccreditationProfileForAdmin } from '@/lib/accreditation'

const urlSchema = z.string().trim().url().or(z.literal('')).optional()
const partnershipSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'اسم الجهة مطلوب').max(220),
  type: z.string().trim().max(120).optional().default(''),
  description: z.string().trim().max(1200).optional().default(''),
  verifyUrl: urlSchema,
  active: z.boolean().optional().default(true),
  displayOrder: z.number().int().min(0).max(100000).optional().default(0),
})

const profileSchema = z.object({
  licenseNumber: z.string().trim().max(160).optional().default(''),
  licenseVerifyUrl: urlSchema,
  licensingAuthority: z.string().trim().max(220).optional().default(''),
  trustNote: z.string().trim().max(1200).optional().default(''),
  partnerships: z.array(partnershipSchema).max(50).optional().default([]),
})

function revalidateAccreditationSurfaces() {
  for (const path of ['/accreditation', '/', '/sitemap.xml']) {
    try { revalidatePath(path) } catch (error) { console.warn('accreditation revalidate failed:', path, error) }
  }
}

export async function GET() {
  const user = await getCurrentUser().catch(() => null)
  if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
  return NextResponse.json({ profile: await getAccreditationProfileForAdmin() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const payload = profileSchema.parse(body.profile || body)
    const profile = await ensureAccreditationProfile()

    await db.$transaction(async (tx) => {
      await tx.accreditationProfile.update({
        where: { id: profile.id },
        data: {
          licenseNumber: payload.licenseNumber || null,
          licenseVerifyUrl: payload.licenseVerifyUrl || null,
          licensingAuthority: payload.licensingAuthority || null,
          trustNote: payload.trustNote || null,
        },
      })

      const incomingIds = payload.partnerships.map((p) => p.id).filter(Boolean) as string[]
      await tx.accreditationPartnership.deleteMany({
        where: { profileId: profile.id, id: { notIn: incomingIds.length ? incomingIds : ['__none__'] } },
      })

      for (let index = 0; index < payload.partnerships.length; index += 1) {
        const item = payload.partnerships[index]
        const data = {
          name: item.name,
          type: item.type || null,
          description: item.description || null,
          verifyUrl: item.verifyUrl || null,
          active: item.active !== false,
          displayOrder: item.displayOrder ?? index,
        }
        if (item.id) {
          await tx.accreditationPartnership.updateMany({ where: { id: item.id, profileId: profile.id }, data })
        } else {
          await tx.accreditationPartnership.create({ data: { profileId: profile.id, ...data } })
        }
      }
    })

    revalidateAccreditationSurfaces()
    await audit(user, 'UPDATE_ACCREDITATION_PROFILE', 'AccreditationProfile', profile.id, `حدّث بيانات صفحة الاعتماد والتحقق (${payload.partnerships.length} شراكة)`)
    return NextResponse.json({ ok: true, profile: await getAccreditationProfileForAdmin() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('accreditation profile update error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر حفظ بيانات الاعتماد' }, { status: 400 })
  }
}
