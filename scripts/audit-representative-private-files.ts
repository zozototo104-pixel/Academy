import { PrismaClient } from '@prisma/client'

// Read-only inventory. Never relocate, delete or mutate uploaded documents automatically.
// Run against the intended environment before PR approval:
// bun run audit:representative-private-files
const db = new PrismaClient()

async function main() {
  const records = await db.academyRepresentativeFile.findMany({
    where: { reviewStatus: { in: ['PENDING_REVIEW', 'REJECTED'] } },
    select: {
      id: true,
      representativeId: true,
      reviewStatus: true,
      storageProvider: true,
      storageKey: true,
      fileUrl: true,
    },
  })
  const risky = records.filter((file) => {
    const privateKey = file.storageKey?.startsWith('representatives-private/')
    const hasPublicUrl = Boolean(file.fileUrl && (/^https?:\/\//i.test(file.fileUrl) || file.fileUrl.startsWith('/uploads/')))
    return hasPublicUrl || (Boolean(file.storageKey) && !privateKey) || file.storageProvider === 'external-url'
  })
  console.log(JSON.stringify({ checked: records.length, requiringManualMigration: risky.map(({ id, representativeId, reviewStatus, storageProvider, storageKey }) => ({ id, representativeId, reviewStatus, storageProvider, storageKey })) }, null, 2))
  if (risky.length) {
    console.error('Legacy pending/rejected files may be publicly accessible. Move them to a verified private bucket, update stored keys in a reviewed transaction, and revoke/delete the old public objects before merging.')
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error('Unable to audit representative file metadata:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}).finally(async () => { await db.$disconnect() })
