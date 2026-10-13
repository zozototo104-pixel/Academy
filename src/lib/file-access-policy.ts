import { db } from '@/lib/db'
import { normalizeStorageKeyForPolicy } from '@/lib/prod-safety'

export type FileAccessUser = { id: string; email?: string | null; role?: string | null }

type FileAccessClient = {
  admissionDocument: { findFirst(args: any): Promise<any> }
  serviceDeliverable: { findFirst(args: any): Promise<any> }
  paymentProof: { findFirst(args: any): Promise<any> }
  assignmentSubmission: { findFirst(args: any): Promise<any> }
  thesisSubmission: { findFirst(args: any): Promise<any> }
}

export function sameFileAccessEmail(a: unknown, b: unknown) {
  const aa = String(a || '').trim().toLowerCase()
  const bb = String(b || '').trim().toLowerCase()
  return !!aa && !!bb && aa === bb
}

export function isFileOwner(user: FileAccessUser, candidate?: { userId?: string | null; email?: string | null } | null) {
  return !!candidate && (candidate.userId === user.id || sameFileAccessEmail(candidate.email, user.email))
}

export async function canAccessStorageKeyWithClient(client: FileAccessClient, key: string, user: FileAccessUser) {
  if (user.role === 'ADMIN') return true
  if (normalizeStorageKeyForPolicy(key).startsWith('backups/')) return false

  const admissionDocument = await client.admissionDocument.findFirst({
    where: { storageKey: key },
    select: { admission: { select: { userId: true, email: true } } },
  })
  if (isFileOwner(user, admissionDocument?.admission)) return true

  const deliverable = await client.serviceDeliverable.findFirst({
    where: { storageKey: key, status: 'PUBLISHED', visibleToStudent: true },
    select: { admission: { select: { userId: true, email: true } } },
  })
  if (isFileOwner(user, deliverable?.admission)) return true

  const proof = await client.paymentProof.findFirst({
    where: { storageKey: key },
    select: {
      uploadedById: true,
      payment: {
        select: {
          userId: true,
          payerEmail: true,
          admission: { select: { userId: true, email: true } },
        },
      },
    },
  })
  if (proof && (proof.uploadedById === user.id || proof.payment.userId === user.id || sameFileAccessEmail(proof.payment.payerEmail, user.email) || isFileOwner(user, proof.payment.admission))) return true

  const assignment = await client.assignmentSubmission.findFirst({
    where: { fileStorageKey: key },
    select: { userId: true },
  })
  if (assignment?.userId === user.id) return true

  const thesis = await client.thesisSubmission.findFirst({
    where: { OR: [{ fileStorageKey: key }, { recordingStorageKey: key }] },
    select: { userId: true },
  })
  if (thesis?.userId === user.id) return true

  return false
}

export async function canAccessStorageKey(key: string, user: FileAccessUser) {
  return canAccessStorageKeyWithClient(db, key, user)
}
