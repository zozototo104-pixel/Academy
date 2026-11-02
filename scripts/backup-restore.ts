import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type BackupLine =
  | { type: 'meta'; platform?: string; format?: string; exportedAt?: string; trigger?: string; tables?: string[] }
  | { type: 'table'; name: string; delegate: string; count: number }
  | { type: 'row'; table: string; data: Record<string, unknown> }
  | { type: 'summary'; counts?: Record<string, number>; errors?: Array<{ table: string; error: string }> }

type TableManifest = {
  name: string
  delegate: string
  expected: number
  rows: Record<string, unknown>[]
}

function usage() {
  console.log(`AACT encrypted backup restore utility

Usage:
  bunx tsx scripts/backup-restore.ts --file ./aact-db-backup.jsonl.gz.enc
  bunx tsx scripts/backup-restore.ts --file ./aact-db-backup.jsonl.gz.enc --restore

Safe defaults:
  - Without --restore this performs a dry-run only.
  - With --restore you must also set AACT_RESTORE_CONFIRM=YES.
  - Restore requires a separately isolated EMPTY database and AACT_RESTORE_ISOLATED_TARGET=YES.
  - A partial/old-schema backup is refused. Writes are atomic and rollback on error.

Required env:
  AACT_BACKUP_ENCRYPTION_KEY  The same key used when the backup was created.
  DATABASE_URL or DIRECT_URL  Target database for restore when --restore is used.
`)
}

function argValue(name: string) {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name)
}

function encryptionKey() {
  const secret = (process.env.AACT_BACKUP_ENCRYPTION_KEY || '').trim()
  if (secret.length < 32) {
    throw new Error('AACT_BACKUP_ENCRYPTION_KEY is required and must be at least 32 characters.')
  }
  return createHash('sha256').update(secret).digest()
}

function sha256(buffer: Buffer | string) {
  return createHash('sha256').update(buffer).digest('hex')
}

function decryptEncryptedBackup(fileBuffer: Buffer) {
  const newline = fileBuffer.indexOf(10)
  if (newline <= 0) throw new Error('Invalid encrypted backup: missing JSON header line.')

  const headerText = fileBuffer.subarray(0, newline).toString('utf8')
  const ciphertext = fileBuffer.subarray(newline + 1)
  const header = JSON.parse(headerText)

  if (header.type !== 'aact-encrypted-backup-v1') {
    throw new Error(`Unsupported encrypted backup type: ${header.type || 'unknown'}`)
  }
  if (header.algorithm !== 'AES-256-GCM') {
    throw new Error(`Unsupported backup encryption algorithm: ${header.algorithm || 'unknown'}`)
  }
  if (!header.iv || !header.authTag) {
    throw new Error('Invalid encrypted backup: missing iv or authTag.')
  }

  const aad = header.aad || {}
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(header.iv, 'base64'))
  decipher.setAAD(Buffer.from(JSON.stringify(aad), 'utf8'))
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'))
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  if (aad.compressedSha256 && aad.compressedSha256 !== sha256(compressed)) {
    throw new Error('Backup integrity check failed: compressedSha256 mismatch.')
  }

  const plain = gunzipSync(compressed)
  if (aad.uncompressedSha256 && aad.uncompressedSha256 !== sha256(plain)) {
    throw new Error('Backup integrity check failed: uncompressedSha256 mismatch.')
  }

  return { header, compressed, plain }
}

function parseBackupJsonl(plain: Buffer) {
  const lines = plain.toString('utf8').split('\n').filter(Boolean)
  const tables = new Map<string, TableManifest>()
  let meta: Extract<BackupLine, { type: 'meta' }> | null = null
  let summary: Extract<BackupLine, { type: 'summary' }> | null = null
  let parsedLines = 0

  for (const raw of lines) {
    const item = JSON.parse(raw) as BackupLine
    parsedLines += 1

    if (item.type === 'meta') {
      meta = item
      continue
    }
    if (item.type === 'table') {
      tables.set(item.name, { name: item.name, delegate: item.delegate, expected: item.count, rows: [] })
      continue
    }
    if (item.type === 'row') {
      const table = tables.get(item.table)
      if (!table) throw new Error(`Found row for table ${item.table} before table manifest.`)
      table.rows.push(item.data)
      continue
    }
    if (item.type === 'summary') {
      summary = item
    }
  }

  return { meta, summary, tables: [...tables.values()], parsedLines }
}

function printPlan(input: {
  file: string
  header: any
  compressed: Buffer
  plain: Buffer
  meta: Extract<BackupLine, { type: 'meta' }> | null
  summary: Extract<BackupLine, { type: 'summary' }> | null
  tables: TableManifest[]
  parsedLines: number
}) {
  console.log('\nEncrypted backup opened successfully.')
  console.log(`File: ${basename(input.file)}`)
  console.log(`Encrypted format: ${input.header.type} / ${input.header.algorithm}`)
  console.log(`Exported at: ${input.meta?.exportedAt || input.header?.aad?.exportedAt || 'unknown'}`)
  console.log(`Trigger: ${input.meta?.trigger || input.header?.aad?.trigger || 'unknown'}`)
  console.log(`Parsed lines: ${input.parsedLines}`)
  console.log(`Compressed bytes: ${input.compressed.byteLength}`)
  console.log(`Uncompressed bytes: ${input.plain.byteLength}`)
  console.log('\nTables found:')
  for (const table of input.tables) {
    const mismatch = table.expected !== table.rows.length ? ` (expected ${table.expected})` : ''
    console.log(`- ${table.name.padEnd(34)} ${String(table.rows.length).padStart(8)} rows${mismatch}`)
  }
  if (input.summary?.errors?.length) {
    console.log('\nBackup was created with table errors:')
    for (const error of input.summary.errors) console.log(`- ${error.table}: ${error.error}`)
  }
}

function preflightBackupTables(parsed: ReturnType<typeof parseBackupJsonl>) {
  if (parsed.meta?.platform !== 'AACT' || parsed.meta?.format !== 'aact-db-jsonl-v1') {
    throw new Error('BACKUP_META_INVALID')
  }
  if (!parsed.summary || !parsed.summary.counts || !Array.isArray(parsed.summary.errors) || parsed.summary.errors.length) {
    throw new Error('BACKUP_INCOMPLETE_OR_FAILED_SUMMARY')
  }
  const expected = new Set(Object.keys(Prisma.ModelName).filter((model) => model !== 'Session'))
  const actual = new Set(parsed.tables.map((table) => table.name))
  const missing = [...expected].filter((name) => !actual.has(name))
  if (missing.length) throw new Error(`BACKUP_INCOMPLETE_SCHEMA_COVERAGE:${missing.join(',')}`)
  if (actual.size !== parsed.tables.length) throw new Error('BACKUP_DUPLICATE_TABLE')
  if (!Array.isArray(parsed.meta.tables) ||
      parsed.meta.tables.length !== parsed.tables.length ||
      parsed.meta.tables.some((name) => !actual.has(name))) {
    throw new Error('BACKUP_TABLE_MANIFEST_MISMATCH')
  }
  for (const table of parsed.tables) {
    if (!(table.name in Prisma.ModelName) ||
        table.delegate !== table.name.charAt(0).toLowerCase() + table.name.slice(1)) {
      throw new Error(`BACKUP_UNKNOWN_MODEL:${table.name}`)
    }
    if (!Number.isSafeInteger(table.expected) || table.expected !== table.rows.length ||
        parsed.summary.counts[table.name] !== table.expected) {
      throw new Error(`BACKUP_ROW_COUNT_MISMATCH:${table.name}`)
    }
  }
}

function parentFirstRestoreOrder(tables: TableManifest[]) {
  const models = Prisma.dmmf.datamodel.models
  const modelNames = new Set(models.map((m) => m.name))
  const waiting = new Map(models.map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind === 'object' && f.relationFromFields?.length &&
      f.type !== m.name && modelNames.has(f.type)).map((f) => f.type)),
  ]))
  const order: string[] = []
  while (waiting.size > 0) {
    const ready = [...waiting].filter(([, dependencies]) =>
      [...dependencies].every((name) => !waiting.has(name))).map(([name]) => name).sort()
    if (ready.length === 0) throw new Error('BACKUP_SCHEMA_DEPENDENCY_CYCLE')
    order.push(...ready)
    for (const name of ready) waiting.delete(name)
  }
  const byName = new Map(tables.map((t) => [t.name, t]))
  return order.map((name) => byName.get(name)).filter((table): table is TableManifest => !!table)
}

async function restoreTables(tables: TableManifest[]) {
  const ordered = parentFirstRestoreOrder(tables)
  const results: Array<{ table: string; inserted: number }> = []
  await prisma.$transaction(async (tx) => {
    for (const table of ordered) {
      const delegate = (tx as any)[table.delegate]
      if (!delegate?.count || !delegate?.createMany) throw new Error(`RESTORE_MODEL_UNAVAILABLE:${table.name}`)
      if (await delegate.count() !== 0) throw new Error(`RESTORE_TARGET_NOT_EMPTY:${table.name}`)
    }
    for (const table of ordered) {
      const delegate = (tx as any)[table.delegate]
      let inserted = 0
      for (let index = 0; index < table.rows.length; index += 300) {
        const batch = await delegate.createMany({ data: table.rows.slice(index, index + 300) })
        inserted += Number(batch?.count || 0)
      }
      if (inserted !== table.rows.length) throw new Error(`RESTORE_ROW_COUNT_MISMATCH:${table.name}`)
      results.push({ table: table.name, inserted })
    }
  }, { maxWait: 30000, timeout: 300000 })
  console.log('Atomic restore completed:', results.length, 'tables; rows', results.reduce((n, r) => n + r.inserted, 0))
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    usage()
    return
  }

  const file = argValue('--file')
  if (!file) {
    usage()
    throw new Error('Missing --file path to encrypted backup.')
  }
  if (!existsSync(file)) throw new Error(`Backup file not found: ${file}`)

  const restore = hasFlag('--restore')
  if (restore && process.env.AACT_RESTORE_CONFIRM !== 'YES') {
    throw new Error('Refusing restore. Set AACT_RESTORE_CONFIRM=YES together with --restore to write to the database.')
  }

  if (restore && process.env.AACT_RESTORE_ISOLATED_TARGET !== 'YES') {
    throw new Error('Refusing restore unless AACT_RESTORE_ISOLATED_TARGET=YES is set for a separate, empty test database.')
  }

  const encrypted = readFileSync(file)
  const { header, compressed, plain } = decryptEncryptedBackup(encrypted)
  const parsed = parseBackupJsonl(plain)
  printPlan({ file, header, compressed, plain, ...parsed })
  preflightBackupTables(parsed)

  if (!restore) {
    console.log('\nDry-run only. No database changes were made.')
    console.log('To restore into the configured database, run again with --restore and AACT_RESTORE_CONFIRM=YES.')
    return
  }

  console.log('\nRESTORE MODE ENABLED. Existing rows will not be deleted. Duplicate primary/unique keys will be skipped when supported.')
  await restoreTables(parsed.tables)
}

main()
  .catch((error) => {
    console.error(`\nbackup-restore failed: ${error?.message || error}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {})
  })
