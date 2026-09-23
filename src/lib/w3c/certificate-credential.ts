import { createHmac } from 'crypto'

export interface CertificateCredentialInput {
  id: string
  serial: string
  qrToken: string
  type: string
  holderName: string
  program: string
  grade?: string | null
  country?: string | null
  issuedAt: Date | string
  valid: boolean
  userId?: string | null
  enrollmentId?: string | null
  admissionId?: string | null
  agentId?: string | null
}

export interface AactVerifiableCertificateCredential {
  '@context': Array<string | Record<string, unknown>>
  id: string
  type: string[]
  issuer: {
    id: string
    name: string
    url: string
  }
  issuanceDate: string
  validFrom: string
  credentialSubject: {
    id: string
    type: string
    name: string
    certificateSerial: string
    certificateType: string
    program: string
    grade?: string | null
    country?: string | null
  }
  credentialStatus: {
    id: string
    type: string
    statusPurpose: string
    status: 'valid' | 'revoked'
  }
  evidence: Array<{
    id: string
    type: string[]
    verifier: string
    serialNumber: string
    verificationToken: string
  }>
  proof?: {
    type: string
    created: string
    proofPurpose: string
    verificationMethod: string
    proofValue: string
  }
}

function getAppUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || 'https://aactacademy.com'
  return raw.replace(/\/$/, '')
}

function issuedIso(value: Date | string) {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function signingSecret() {
  return process.env.AACT_VC_SIGNING_SECRET || process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_URL || 'aact-local-verifiable-credential-secret'
}

function base64url(input: Buffer) {
  return input.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
}

function signPayload(payload: unknown) {
  return base64url(createHmac('sha256', signingSecret()).update(canonicalize(payload)).digest())
}

export function certificateVerificationUrl(cert: { qrToken: string }) {
  return `${getAppUrl()}/verify/certificates/${encodeURIComponent(cert.qrToken)}`
}

export function certificateCredentialUrl(cert: { qrToken: string }) {
  return `${getAppUrl()}/api/verify/certificates/${encodeURIComponent(cert.qrToken)}`
}

export function buildCertificateCredential(cert: CertificateCredentialInput): AactVerifiableCertificateCredential {
  const base = getAppUrl()
  const issued = issuedIso(cert.issuedAt)
  const verifyUrl = certificateVerificationUrl(cert)
  const credentialUrl = certificateCredentialUrl(cert)
  const issuerId = `${base}/issuer/aact`
  const unsigned: AactVerifiableCertificateCredential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      {
        AACTCertificateCredential: `${base}/contexts/aact-certificate-v1`,
        certificateSerial: `${base}/terms/certificateSerial`,
        certificateType: `${base}/terms/certificateType`,
        program: `${base}/terms/program`,
        grade: `${base}/terms/grade`,
        country: `${base}/terms/country`,
      },
    ],
    id: credentialUrl,
    type: ['VerifiableCredential', 'AACTCertificateCredential'],
    issuer: {
      id: issuerId,
      name: 'American Academy for Consulting and Training',
      url: base,
    },
    issuanceDate: issued,
    validFrom: issued,
    credentialSubject: {
      id: `${verifyUrl}#subject`,
      type: 'AACTCertificateHolder',
      name: cert.holderName,
      certificateSerial: cert.serial,
      certificateType: cert.type,
      program: cert.program,
      grade: cert.grade || null,
      country: cert.country || null,
    },
    credentialStatus: {
      id: `${verifyUrl}#status`,
      type: 'AACTCertificateStatus2026',
      statusPurpose: 'revocation',
      status: cert.valid ? 'valid' : 'revoked',
    },
    evidence: [
      {
        id: verifyUrl,
        type: ['DocumentVerification', 'AACTCertificateEvidence'],
        verifier: 'AACT Platform',
        serialNumber: cert.serial,
        verificationToken: cert.qrToken,
      },
    ],
  }

  return {
    ...unsigned,
    proof: {
      type: 'HmacSha256Signature2026',
      created: issued,
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuerId}#internal-hmac-sha256`,
      proofValue: signPayload(unsigned),
    },
  }
}

export function verifyCertificateCredential(credential: AactVerifiableCertificateCredential) {
  const { proof, ...unsigned } = credential
  if (!proof?.proofValue) return false
  return signPayload(unsigned) === proof.proofValue
}
