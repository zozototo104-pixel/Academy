import { readFileSync } from 'fs'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const waiverLib = readFileSync('src/lib/payment-waivers.ts', 'utf8')
const paymentsRoute = readFileSync('src/app/api/payments/route.ts', 'utf8')

assert(String(pkg.scripts?.quality || '').includes('bun run test:payments'), 'quality must include test:payments')
assert(waiverLib.includes('hashWaiverCode') && waiverLib.includes('generateWaiverCode'), 'payment waiver codes must remain hashed/generated server-side')
assert(paymentsRoute.includes("const isPrivileged = user.role === 'ADMIN'"), 'payments privileged access must remain ADMIN-only')

console.log('✓ payment safety checks passed')
