/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Coverage guard (step 7): scripts/check-ai-router-coverage.ts must pass
// on this tree, and must detect a synthetic direct-provider call.
import { checkAiRouterCoverage } from '../../scripts/check-ai-router-coverage'

const ROOT = join(import.meta.dir, '..', '..')

describe('AI router coverage guard (step 7)', () => {
  test('passes on this tree: no non-allowlisted direct provider call', () => {
    const result = checkAiRouterCoverage(ROOT)
    expect(result.checkedFiles).toBeGreaterThan(100)
    expect(result.violations).toEqual([])
  })

  test('detects a synthetic direct-provider call in a new file', () => {
    const tmpRoot = join(import.meta.dir, '__coverage-tmp')
    try {
      mkdirSync(join(tmpRoot, 'src', 'lib'), { recursive: true })
      writeFileSync(join(tmpRoot, 'src', 'lib', 'evil.ts'), "import { GoogleGenAI } from '@google/genai'\nconst ai = new GoogleGenAI({ apiKey: 'x' })\n")
      writeFileSync(join(tmpRoot, 'src', 'lib', 'ok.ts'), "export const x = 1\n")
      const result = checkAiRouterCoverage(tmpRoot)
      expect(result.violations.length).toBe(1)
      expect(result.violations[0]?.file).toBe('src/lib/evil.ts')
      expect(result.violations[0]?.pattern).toBe('new GoogleGenAI(')
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
