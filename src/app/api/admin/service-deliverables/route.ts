import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'
import { deliverableTypeLabel, normalizeDeliverableType } from '@/lib/service-deliverables'
import { emailServiceDeliverablePublished } from '@/lib/mailer'
import { getServiceFlow } from '@/lib/service-flows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: FormDataEntryValue | null, max = 500): string {
  return String(value || '').trim().slice(0, max)
}

function asBool(value: FormDataEntryValue | null, fallback = true): boolean {
  const raw = String(value || '').trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(raw)) return false
  if (['true', '1', 'yes', 'on'].includes(raw)) return true
  return fallback
}

function parseDate(value: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin()
    const form = await req.formData()
    const admissionId = clean(form.get('admissionId'), 120)
    const type = normalizeDeliverableType(clean(form.get('type'), 80))
    const title = clean(form.get('title'), 220)
    const description = clean(form.get('description'), 2000)
    const externalUrl = clean(form.get('externalUrl'), 1200)
    const certificateId = clean(form.get('certificateId'), 120)
    const verificationUrl = clean(form.get('verificationUrl'), 1200)
    const status = clean(form.get('status'), 30) || 'PUBLISHED'
    const visibleToStudent = asBool(form.get('visibleToStudent'), true)
    const meetingAt = parseDate(clean(form.get('meetingAt'), 80))
    const expiresAt = parseDate(clean(form.get('expiresAt'), 80))
    const file = form.get('file')

    if (!admissionId) return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 400 })
    if (!title) return NextResponse.json({ error: 'TITLE_REQUIRED' }, { status: 400 })
    if (!['DRAFT', 'PUBLISHED', 'REVOKED'].includes(status)) return NextResponse.json({ error: 'INVALID_STATUS' }, { status: 400 })

    const admission = await db.admissionApplication.findUnique({
      where: { id: admissionId },
      select: { id: true, fullName: true, email: true, reference: true, program: true },
    })
    if (!admission) return NextResponse.json({ error: 'ADMISSION_NOT_FOUND' }, { status: 404 })

    let stored: { provider?: string; key?: string; url?: string; fileName?: string; mimeType?: string; size?: number } = {}
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const saved = await storeFileBuffer({
        buffer,
        fileName: file.name || `${title}.pdf`,
        mimeType: file.type || 'application/octet-stream',
        namespace: `service-deliverables/${admission.reference}`,
      })
      stored = {
        provider: saved.provider,
        key: saved.key,
        url: saved.url,
        fileName: file.name || title,
        mimeType: saved.mimeType,
        size: saved.size,
      }
    }

    if (!stored.key && !externalUrl && !certificateId && !verificationUrl) {
      return NextResponse.json({ error: 'DELIVERABLE_TARGET_REQUIRED', message: 'أضف ملفاً أو رابطاً أو رقم شهادة/تحقق.' }, { status: 400 })
    }

    const deliverable = await db.serviceDeliverable.create({
      data: {
        admissionId,
        type,
        title,
        description: description || null,
        fileName: stored.fileName || null,
        mimeType: stored.mimeType || null,
        size: Number(stored.size || 0),
        storageProvider: stored.provider || null,
        storageKey: stored.key || null,
        fileUrl: stored.url || null,
        externalUrl: externalUrl || null,
        certificateId: certificateId || null,
        verificationUrl: verificationUrl || null,
        meetingAt,
        expiresAt,
        status,
        visibleToStudent,
        createdById: admin.id,
        createdByName: admin.name,
      },
    })

    if (status === 'PUBLISHED' && visibleToStudent) {
      emailServiceDeliverablePublished(admission.email, admission.fullName, admission.reference, title, deliverableTypeLabel(type)).catch(() => {})
    }

    return NextResponse.json({ ok: true, deliverable })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    if (msg.includes('FILE_STORAGE') || msg.includes('S3_UPLOAD_FAILED') || msg.includes('EMPTY_FILE')) {
      return NextResponse.json({ error: 'UPLOAD_FAILED', message: storageErrorMessage(e) }, { status: 400 })
    }
    return NextResponse.json({ error: 'SERVER_ERROR', message: msg.slice(0, 200) }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    await requireAdmin()
    const body = await req.json()
    const id = String(body?.id || '').trim()
    if (!id) return NextResponse.json({ error: 'ID_REQUIRED' }, { status: 400 })
    const data: any = {}
    if (typeof body?.status === 'string' && ['DRAFT', 'PUBLISHED', 'REVOKED'].includes(body.status)) data.status = body.status
    if (typeof body?.visibleToStudent === 'boolean') data.visibleToStudent = body.visibleToStudent
    if (typeof body?.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 220)
    if (typeof body?.description === 'string') data.description = body.description.trim().slice(0, 2000) || null
    const deliverable = await db.serviceDeliverable.update({ where: { id }, data })
    return NextResponse.json({ ok: true, deliverable })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json({ error: 'SERVER_ERROR', message: msg.slice(0, 200) }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    await requireAdmin()
    const { searchParams } = new URL(req.url)
    const id = String(searchParams.get('id') || '').trim()
    if (!id) return NextResponse.json({ error: 'ID_REQUIRED' }, { status: 400 })
    await db.serviceDeliverable.update({ where: { id }, data: { status: 'REVOKED', visibleToStudent: false } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    return NextResponse.json({ error: 'SERVER_ERROR', message: msg.slice(0, 200) }, { status: 500 })
  }
}
