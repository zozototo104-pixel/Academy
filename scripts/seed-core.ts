import { ensureCoreSeed } from '../src/lib/bootstrap'
import { db } from '../src/lib/db'

async function main() {
  // يزرع البرامج الأساسية والإعدادات فقط، بدون حسابات تجريبية أو طلبات قبول تجريبية.
  // في الإنتاج لن ينشئ المدير الافتراضي إلا إذا فُعّل AACT_BOOTSTRAP_DEFAULT_ADMIN=1، والأفضل استخدام bun run admin:create.
  await ensureCoreSeed(true)
  console.log('Core catalog/settings seed complete.')
}

main()
  .catch((e) => {
    console.error('Core seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
