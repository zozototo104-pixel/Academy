import { describe, expect, test } from 'bun:test'

const { POST } = await import('../../src/app/api/client-error/route')
const { NextRequest } = await import('next/server')

function post(body: string, ip = '198.51.100.1') {
  return POST(new NextRequest('https://example.test/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body,
  }) as any)
}

describe('client error reporting', () => {
  test('a valid report is accepted and logged with its page and browser', async () => {
    const logged: any[][] = []
    const original = console.error
    console.error = (...args: any[]) => { logged.push(args) }
    try {
      const res = await post(JSON.stringify({
        message: 'Blocked aria-hidden on a div element',
        stack: 'Error: Blocked aria-hidden\n    at hideOthers',
        digest: 'abc123',
        url: 'https://example.test/admin?tab=students',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const report = logged.find((args) => args[0] === 'AACT client error report:')
      expect(report).toBeTruthy()
      const payload = JSON.parse(String(report![1]))
      expect(payload.message).toContain('Blocked aria-hidden')
      expect(payload.digest).toBe('abc123')
      expect(payload.url).toBe('https://example.test/admin')
      expect(payload.url).not.toContain('tab=students')
      expect(payload.userAgent).toContain('iPhone')
    } finally {
      console.error = original
    }
  })

  test('an empty message is rejected', async () => {
    const res = await post(JSON.stringify({ message: '' }))
    expect(res.status).toBe(400)
  })

  test('malformed JSON is rejected', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(400)
  })

  test('oversized fields are capped before logging', async () => {
    const logged: any[][] = []
    const original = console.error
    console.error = (...args: any[]) => { logged.push(args) }
    try {
      const res = await post(JSON.stringify({ message: 'boom', stack: 'x'.repeat(9000) }))
      expect(res.status).toBe(200)
      const report = logged.find((args) => args[0] === 'AACT client error report:')
      const payload = JSON.parse(String(report![1]))
      expect(payload.stack.length).toBeLessThanOrEqual(4000)
    } finally {
      console.error = original
    }
  })
})
