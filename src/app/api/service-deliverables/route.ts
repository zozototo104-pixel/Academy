import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { deliverableStatusLabel, deliverableTypeLabel } from '@/lib/service-deliverables'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireUser()
    const applications = await db.admissionApplication.findMany({
      where: {
        OR: [
          { userId: user.id },
          { email: user.email },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        program: true,
        status: true,
        createdAt: true,
        payments: { select: { status: true } },
        deliverables: {
          where: { status: 'PUBLISHED', visibleToStudent: true },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            description: true,
            fileName: true,
            mimeType: true,
            size: true,
            externalUrl: true,
            fileUrl: true,
            certificateId: true,
            verificationUrl: true,
            meetingAt: true,
            expiresAt: true,
            createdAt: true,
          },
        },
      },
    })

    const rows = applications.map((app) => ({
      ...app,
      deliverables: app.deliverables.map((d) => ({
        ...d,
        typeLabel: deliverableTypeLabel(d.type),
        statusLabel: deliverableStatusLabel(d.status),
        downloadUrl: `/api/service-deliverables/${d.id}/download`,
      })),
    }))
    return NextResponse.json({ applications: rows, deliverables: rows.flatMap((a) => a.deliverables.map((d) => ({ ...d, application: { id: a.id, reference: a.reference, program: a.program } }))) })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json({ error: 'SERVER_ERROR', message: msg.slice(0, 200) }, { status: 500 })
  }
}
