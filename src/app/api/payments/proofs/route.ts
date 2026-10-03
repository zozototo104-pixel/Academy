import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { validateAdmissionFileSignature } from '@/lib/file-signature'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'
import { audit, notify } from '@/lib/notify'
import { repairVerifiedStudentRecordOwnership, studentPaymentOwnershipWhere } from '@/lib/student-record-ownership'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_PROOF_BYTES = 8 * 1024 * 1024
const MANUAL_METHODS = new Set(['DIRECT_PAYMENT', 'BANK_TRANSFER', 'USDT', 'CASH'])
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
])

function cleanText(value: unknown, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function checksum(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function proofPayload(proof: any) {
  return {
    id: proof.id,
    paymentId: proof.paymentId,
    proofType: proof.proofType,
    status: proof.status,
    note: proof.note,
    adminNote: proof.adminNote,
    fileName: proof.fileName,
    mimeType: proof.mimeType,
    fileSize: proof.fileSize,
    checksum: proof.checksum,
    createdAt: proof.createdAt,
    reviewedAt: proof.reviewedAt,
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    await repairVerifiedStudentRecordOwnership(user).catch(() => null)

    const form = await req.formData()
    const paymentId = cleanText(form.get('paymentId'), 120)
    const proofType = cleanText(form.get('proofType'), 60) || 'TRANSFER_RECEIPT'
    const note = cleanText(form.get('note'), 700) || null
    const file = form.get('file')

    if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
    if (!(file instanceof File)) return NextResponse.json({ error: 'ملف إثبات الدفع مطلوب' }, { status: 400 })
    if (file.size <= 0) return NextResponse.json({ error: 'ملف إثبات الدفع فارغ' }, { status: 400 })
    if (file.size > MAX_PROOF_BYTES) return NextResponse.json({ error: 'حجم ملف الإثبات يجب ألا يتجاوز 8MB' }, { status: 400 })

    const payment = await db.payment.findFirst({
      where: user.role === 'ADMIN' || user.role === 'SUPERVISOR'
        ? { id: paymentId }
        : { AND: [{ id: paymentId }, studentPaymentOwnershipWhere(user)] },
      select: { id: true, invoiceNo: true, status: true, method: true, provider: true, description: true, amount: true, userId: true },
    })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة أو غير مرتبطة بحسابك' }, { status: 404 })
    if (payment.status === 'PAID') return NextResponse.json({ error: 'الفاتورة مسددة بالفعل ولا تحتاج إثبات دفع جديد' }, { status: 400 })

    const manualMethod = String(payment.method || payment.provider || '').toUpperCase()
    if (!MANUAL_METHODS.has(manualMethod)) {
      return NextResponse.json({ error: 'ارفع إثبات الدفع بعد اختيار وسيلة دفع يدوية مثل التحويل المباشر أو USDT.' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const signature = validateAdmissionFileSignature({ buffer, fileName: file.name, mimeType: file.type })
    if (!signature.ok) return NextResponse.json({ error: signature.error }, { status: 400 })
    if (!ALLOWED_MIME.has(signature.mimeType)) {
      return NextResponse.json({ error: 'صيغة إثبات الدفع غير مدعومة. ارفع صورة أو PDF أو ملف Word نصي واضح.' }, { status: 400 })
    }

    const hash = checksum(buffer)
    const existing = await db.paymentProof.findUnique({
      where: { paymentId_checksum: { paymentId: payment.id, checksum: hash } },
    }).catch(() => null)
    if (existing) return NextResponse.json({ ok: true, proof: proofPayload(existing), duplicate: true })

    const stored = await storeFileBuffer({
      buffer,
      fileName: file.name || `${payment.invoiceNo}-payment-proof`,
      mimeType: signature.mimeType,
      namespace: `payment-proofs/${payment.id}`,
    })

    const proof = await db.paymentProof.create({
      data: {
        paymentId: payment.id,
        uploadedById: user.id,
        proofType,
        status: 'PENDING',
        note,
        fileName: file.name || `${payment.invoiceNo}-payment-proof`,
        mimeType: signature.mimeType,
        fileSize: buffer.byteLength,
        checksum: hash,
        storageProvider: stored.provider,
        storageKey: stored.key,
        storageUrl: stored.url,
      },
    })

    const admins = await db.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true }, take: 20 }).catch(() => [])
    await Promise.all(admins.map((admin) => notify(admin.id, 'PAYMENT_PROOF_UPLOADED', 'إثبات دفع جديد', `تم رفع إثبات دفع للفاتورة ${payment.invoiceNo}`, '/admin?tab=finance')))
    await audit({ id: user.id, name: user.name }, 'UPLOAD_PAYMENT_PROOF', 'Payment', payment.id, `${payment.invoiceNo} — ${payment.amount}$ — ${proof.fileName}`)

    return NextResponse.json({ ok: true, proof: proofPayload(proof) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب لرفع إثبات الدفع' }, { status: 401 })
    console.error('payment proof upload error:', e)
    return NextResponse.json({ error: storageErrorMessage(e) || 'تعذر رفع إثبات الدفع' }, { status: 500 })
  }
}
