import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type BackupLine =
  | { type: 'meta'; platform?: string; format?: string; exportedAt?: string; trigger?: string; tables?: string[] }
  | { type: 'table'; name: string; delegate: string; count: number }
  | { type: 'row'; table: string; data: Record<string, unknown> }
  | { type: 'summary'; counts?: Record<string, number>; errors?: Array<{ table: string; error: string }> }
  | { type: string; [key: string]: unknown }

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
  - Restore uses createMany({ skipDuplicates: true }) and does not wipe existing data.

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

async function restoreTables(tables: TableManifest[]) {
  const results: Array<{ table: string; insertedOrSkipped: number; error?: string }> = []

  for (const table of tables) {
    const delegate = (prisma as any)[table.delegate]
    if (!delegate?.createMany) {
      results.push({ table: table.name, insertedOrSkipped: 0, error: `Delegate ${table.delegate} does not support createMany.` })
      continue
    }
    if (!table.rows.length) {
      results.push({ table: table.name, insertedOrSkipped: 0 })
      continue
    }

    try {
      const result = await delegate.createMany({ data: table.rows, skipDuplicates: true })
      results.push({ table: table.name, insertedOrSkipped: result?.count ?? table.rows.length })
      console.log(`RESTORE ${table.name}: createMany count=${result?.count ?? 'unknown'} / backup rows=${table.rows.length}`)
    } catch (error: any) {
      const message = error?.message || String(error)
      results.push({ table: table.name, insertedOrSkipped: 0, error: message })
      console.error(`RESTORE ${table.name}: FAILED: ${message}`)
    }
  }

  const failed = results.filter((r) => r.error)
  console.log('\nRestore summary:')
  for (const row of results) {
    console.log(`- ${row.table}: ${row.error ? `FAILED — ${row.error}` : `processed ${row.insertedOrSkipped}`}`)
  }
  if (failed.length) {
    throw new Error(`Restore completed with ${failed.length} failed table(s). Review errors above.`)
  }
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

  const encrypted = readFileSync(file)
  const { header, compressed, plain } = decryptEncryptedBackup(encrypted)
  const parsed = parseBackupJsonl(plain)
  printPlan({ file, header, compressed, plain, ...parsed })

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
