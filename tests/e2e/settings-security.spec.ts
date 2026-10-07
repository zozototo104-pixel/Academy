import { expect, test } from '@playwright/test'

const SECRET_KEY_RE = /KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD/i

function collectKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => collectKeys(item, `${prefix}[${index}]`))
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return [path, ...collectKeys(child, path)]
  })
}

test('public /api/settings response does not expose secret-looking keys', async ({ request }) => {
  const res = await request.get('/api/settings')
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  const leakedKeys = collectKeys(json).filter((keyPath) => {
    const lastSegment = keyPath.split('.').pop() || keyPath
    return SECRET_KEY_RE.test(lastSegment)
  })
  expect(leakedKeys, `Public settings leaked secret-looking keys: ${leakedKeys.join(', ')}`).toEqual([])
})
