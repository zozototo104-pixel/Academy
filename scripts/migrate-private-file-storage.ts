import { PrismaClient } from '@prisma/client'
import { runPrivateFilesMaintenanceBatch, mergePrivateFilesReports, emptyPrivateFilesReport, type PrivateFilesMode } from '../src/lib/private-files-maintenance'

const prisma = new PrismaClient()

function argValue(name: string) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] || '' : ''
}

function selectedMode(): PrivateFilesMode {
  if (process.argv.includes('--execute')) return 'execute'
  const raw = argValue('mode')
  return raw === 'execute' ? 'execute' : 'dry-run'
}

async function main() {
  const mode = selectedMode()
  const confirm = process.env.PRIVATE_FILES_MIGRATION_CONFIRM || argValue('confirm') || ''
  const batchSize = Math.max(1, Math.min(50, Number(argValue('batch-size') || 50)))
  let cursor: string | null = argValue('cursor') || null
  let aggregate = emptyPrivateFilesReport(mode, batchSize)

  do {
    const batch = await runPrivateFilesMaintenanceBatch({
      db: prisma,
      mode,
      confirm,
      cursor,
      batchSize,
      actor: { name: 'script:migrate-private-file-storage' },
    })
    aggregate = mergePrivateFilesReports(aggregate, batch)
    cursor = batch.nextCursor
  } while (cursor)

  console.log(JSON.stringify(aggregate, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
