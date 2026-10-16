/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { withTimedResponse, withTiming } from '../../src/lib/timing'

describe('timing helpers', () => {
  test('withTiming returns the wrapped value', async () => {
    await expect(withTiming('db_test_query', async () => 42)).resolves.toBe(42)
  })

  test('withTimedResponse adds timing and byte headers without changing the body', async () => {
    const response = await withTimedResponse(async () => {
      const payload = JSON.stringify({ ok: true, value: 'same-body' })
      return new Response(payload, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    })

    expect(response.headers.get('Server-Timing')).toContain('serialize')
    expect(response.headers.get('X-Response-Bytes')).toBe(String(new TextEncoder().encode(JSON.stringify({ ok: true, value: 'same-body' })).byteLength))
    await expect(response.json()).resolves.toEqual({ ok: true, value: 'same-body' })
  })
})
