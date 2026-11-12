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

  test('verification tokens, URL query strings and bearer tokens never reach logs', async () => {
    const logged: any[][] = []
    const original = console.error
    console.error = (...args: any[]) => { logged.push(args) }
    try {
      const res = await post(JSON.stringify({
        message: 'failed https://academy.test/verify-email?token=SECRET_VALUE_123#secret',
        stack: 'Bearer SECRET_BEARER_123456 at https://academy.test/verify-email?code=SECRET_CODE_123',
        url: 'https://academy.test/verify-email?token=SECRET_VALUE_123#secret',
        digest: 'diagnostic-123',
      }), '198.51.100.50')
      expect(res.status).toBe(200)
      const report = logged.find((args) => args[0] === 'AACT client error report:')
      const payload = JSON.parse(String(report![1]))
      expect(payload.url).toBe('https://academy.test/verify-email')
      expect(payload.message).not.toContain('SECRET')
      expect(payload.stack).not.toContain('SECRET')
      expect(payload.digest).toBe('diagnostic-123')
    } finally {
      console.error = original
    }
  })

  test('refuses oversized payloads with HTTP 413', async () => {
    const res = await post(JSON.stringify({ message: 'oversize', stack: 'x'.repeat(22_000) }), '198.51.100.51')
    expect(res.status).toBe(413)
  })

  test('throttles repeated unauthenticated crash reports instead of flooding logs', async () => {
    const original = console.error
    console.error = () => {}
    try {
      let response: Response | undefined
      for (let i = 0; i < 21; i++) {
        response = await post(JSON.stringify({ message: 'repeated client error' }), '198.51.100.52')
      }
      expect(response?.status).toBe(429)
      expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0)
    } finally {
      console.error = original
    }
  })
})
