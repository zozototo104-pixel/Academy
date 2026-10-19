import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

function pad(n: number, width = 5) {
  return String(n).padStart(width, '0')
}

export async function nextCertificateSerial(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ value: bigint | number }>>`SELECT nextval('"Certificate_serial_seq"') AS value`
  const next = Number(rows[0]?.value || 0)
  if (!Number.isFinite(next) || next <= 0) throw new Error('CERTIFICATE_SERIAL_SEQUENCE_UNAVAILABLE')
  return `AACT-C-${new Date().getFullYear()}-${pad(next, 5)}`
}

export function createCertificateQrToken() {
  return randomBytes(16).toString('hex')
}
