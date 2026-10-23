/// <reference types="bun-types" />
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

const ROUTES = [
  { name: 'transcript', path: 'src/app/api/pdf/transcript/route.ts', builder: 'buildTranscriptPdf' },
  { name: 'results', path: 'src/app/api/pdf/results/[id]/route.ts', builder: 'buildOfficialPdf' },
  { name: 'service-deliverables', path: 'src/app/api/pdf/service-deliverables/[id]/route.ts', builder: 'buildOfficialPdf' },
]

describe('official document PDF routes use the embedded-font Arabic pipeline', () => {
  for (const route of ROUTES) {
    test(`${route.name} route renders via ${route.builder} + loadArabicCanvas, never the SVG/sharp renderer`, () => {
      const source = readFileSync(join(process.cwd(), route.path), 'utf8')
      expect(source).toContain(route.builder)
      expect(source).toContain('loadArabicCanvas()')
      expect(source).not.toContain('renderOfficialPdf')
    })
  }

  test('the shared builder embeds the Amiri font and draws Arabic via the canvas pipeline', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/transcript-pdf.ts'), 'utf8')
    expect(source).toContain('registerArabicFont')
    expect(source).toContain('drawArabicImage')
    expect(source).not.toContain('sharp')
  })
})
