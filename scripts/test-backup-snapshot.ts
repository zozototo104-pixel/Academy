/**
 * CI-only integration check — run by the `backup-restore-postgres` job in
 * .github/workflows/ci.yml against a real, disposable PostgreSQL.
 *
 * Proves that createDatabaseBackup reads from ONE consistent snapshot:
 * a pair of linked rows (User + its Notification) is updated in a single
 * transaction from a second connection WHILE the backup is running.
 * Whatever instant the snapshot represents, the pair in the backup file
 * must be entirely OLD or entirely NEW — never torn (one old, one new).
 *
 * Requires: generated Prisma client, DATABASE_URL, AACT_BACKUP_ENCRYPTION_KEY.
 * Not part of the local quality chain (needs a real database).
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { createDatabaseBackup } from '@/lib/backups'
import { readStoredFile } from '@/lib/storage'

const USER_ID = 'snapshot-pair-user'
const NOTIFICATION_ID = 'snapshot-pair-notification'
const OLD_EMAIL = 'snapshot-old@example.test'
const NEW_EMAIL = 'snapshot-new@example.test'
const OLD_TITLE = 'SNAPSHOT_OLD'
const NEW_TITLE = 'SNAPSHOT_NEW'

function fail(message: string): never {
  throw new Error(`BACKUP_SNAPSHOT_CHECK_FAILED:${message}`)
}

async function main() {
  // Seed the linked pair plus enough rows to widen the export window.
  await db.user.create({
    data: { id: USER_ID, email: OLD_EMAIL, password: 'snapshot-test-only' },
  })
  await db.notification.create({
    data: { id: NOTIFICATION_ID, userId: USER_ID, type: 'GENERAL', title: OLD_TITLE, body: 'pair' },
  })
  await db.notification.createMany({
    data: Array.from({ length: 1200 }, (_, i) => ({
      id: `snapshot-bulk-${i}`,
      userId: USER_ID,
      type: 'GENERAL',
      title: `bulk ${i}`,
      body: 'bulk',
    })),
  })

  // Concurrent writer: one atomic transaction from a second connection,
  // fired while the backup is exporting.
  const writer = new PrismaClient()
  const writePromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writer.$transaction([
      writer.user.update({ where: { id: USER_ID }, data: { email: NEW_EMAIL } }),
      writer.notification.update({ where: { id: NOTIFICATION_ID }, data: { title: NEW_TITLE } }),
    ])
  })()

  const result: any = await createDatabaseBackup('cron')
  await writePromise
  await writer.$disconnect().catch(() => {})

  if (!result?.ok) fail(`backup not ok: ${JSON.stringify(result?.errors || result)}`)

  // Read the stored backup back and decrypt it (same format the CI
  // fixture builder in ci.yml writes).
  const stored = await readStoredFile({
    provider: result.storage.provider,
    key: result.storage.key,
    mimeType: result.storage.mimeType,
  })
  if (!stored?.buffer) fail('stored backup file not readable')

  const headerEnd = stored.buffer.indexOf(10)
  const header = JSON.parse(stored.buffer.subarray(0, headerEnd).toString('utf8'))
  const key = createHash('sha256').update(String(process.env.AACT_BACKUP_ENCRYPTION_KEY || '')).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(Buffer.from(JSON.stringify(header.aad)))
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'))
  const compressed = Buffer.concat([decipher.update(stored.buffer.subarray(headerEnd + 1)), decipher.final()])
  const plain = gunzipSync(compressed).toString('utf8')

  let userRow: any = null
  let notificationRow: any = null
  for (const rawLine of plain.split('\n')) {
    if (!rawLine.trim()) continue
    const entry = JSON.parse(rawLine)
    if (entry.type === 'row' && entry.table === 'User' && entry.data?.id === USER_ID) userRow = entry.data
    if (entry.type === 'row' && entry.table === 'Notification' && entry.data?.id === NOTIFICATION_ID) notificationRow = entry.data
  }
  if (!userRow) fail('pair user row missing from backup')
  if (!notificationRow) fail('pair notification row missing from backup')

  const pairIsOld = userRow.email === OLD_EMAIL && notificationRow.title === OLD_TITLE
  const pairIsNew = userRow.email === NEW_EMAIL && notificationRow.title === NEW_TITLE
  if (!pairIsOld && !pairIsNew) {
    fail(`torn snapshot: email=${userRow.email} title=${notificationRow.title}`)
  }

  console.log(`BACKUP_SNAPSHOT_CONSISTENCY_OK pair=${pairIsOld ? 'OLD' : 'NEW'} tables=${result.tables}`)
}

main()
  .then(async () => {
    await db.$disconnect().catch(() => {})
    process.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    await db.$disconnect().catch(() => {})
    process.exit(1)
  })
