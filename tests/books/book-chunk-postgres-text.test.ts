import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripPostgresForbiddenChars } from '../../src/lib/postgres-text'

// Regression for the 2026-11-23 live failure: a book page whose PDF text
// layer embeds a NUL byte (0x00) made prisma.bookChunk.upsert() fail with
// Postgres 22021 "invalid byte sequence for encoding UTF8" and stalled the
// whole read job — retrying re-read the same page and failed identically.
// Chunk text must be stripped of Postgres-forbidden characters before it
// is saved. A direct planBookChunks behaviour test cannot run here: importing
// src/lib/book-reader.ts pulls in the Prisma client, which is not generated
// in this sandbox — so the sanitizer itself is tested behaviourally below
// and its wiring into planBookChunks is pinned by source, the same pattern
// as tests/books/book-read-failure-honesty.test.ts.

describe('stripPostgresForbiddenChars', () => {
  it('removes NUL bytes from Arabic PDF text', () => {
    expect(stripPostgresForbiddenChars('مبادئ\u0000المحاسبة 2')).toBe('مبادئالمحاسبة 2')
  })

  it('removes other forbidden C0 controls and DEL', () => {
    expect(stripPostgresForbiddenChars('a\u0001b\u001Fc\u007Fd')).toBe('abcd')
  })

  it('keeps tab, newline and carriage return, which Postgres allows', () => {
    expect(stripPostgresForbiddenChars('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('leaves clean text untouched', () => {
    const clean = 'يتضمن مجموعة الرموز العربية'
    expect(stripPostgresForbiddenChars(clean)).toBe(clean)
  })

  it('returns empty for text made only of forbidden characters', () => {
    expect(stripPostgresForbiddenChars('\u0000\u0001')).toBe('')
  })
})

describe('planBookChunks wiring', () => {
  const bookReader = readFileSync(join(import.meta.dir, '..', '..', 'src/lib/book-reader.ts'), 'utf8')

  it('sanitizes the chunk text inside planBookChunks before hashing', () => {
    expect(bookReader).toContain("import { stripPostgresForbiddenChars } from '@/lib/postgres-text'")
    expect(bookReader).toContain('stripPostgresForbiddenChars(text.trim())')
  })

  it('sanitizes the heading path too', () => {
    expect(bookReader).toContain('stripPostgresForbiddenChars(headingPath)')
  })
})
