/// <reference types="bun-types" />
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { inflateSync } from 'zlib'
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFNumber } from 'pdf-lib'
import { describe, expect, test } from 'bun:test'
import { bundledStampFontsDir, stampFontsConfContent } from '@/lib/legacy-certificate-files'

// Production downloads of every official PDF (certificates, transcripts,
// invoices) rendered all Arabic text as tofu boxes: renderOfficialPdf
// rasterizes its SVG through sharp/librsvg, which resolves fonts through
// fontconfig system fonts only and ignores the SVG @font-face block. The
// production server has no Arabic system font; local and CI machines have
// Noto fonts, so the old source-text assertions stayed green while the
// defect shipped. renderOfficialPdf now points fontconfig at the embedded
// fonts first (ensureStampFonts, the legacy-stamp mechanism).
//
// This test renders the real official document in three isolated
// environments (see render-official-fixture.ts), extracts the rasterized
// first page from each PDF, and compares pixels — the same discipline as
// tests/legacy-graduates/stamp-fonts.test.ts. Nothing is compared against
// the machine's own system fonts. The assertions, together:
//   1. the production code path under Node (ensureStampFonts) renders
//      exactly like the embedded-font render;
//   2. the embedded-font render is real text, not tofu (it must differ
//      sharply from the fontless render across the text-bearing page).
// If the embedded fonts broke, (2) would fail. If ensureStampFonts stopped
// being called, (1) would fail: the Node run's fontconfig is isolated via
// FONTCONFIG_PATH holding an empty fonts.conf, so — exactly like the
// production server — it finds no system fonts at all, while
// FONTCONFIG_FILE stays unset so ensureStampFonts() itself must do the
// pointing. (The fontless Node render is ~17 KB with hollow-box ink,
// byte-for-byte the shape of the broken production downloads.)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const HELPER = path.join(HERE, 'render-official-fixture.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

type Ink = { mask: Uint8Array; count: number; width: number; height: number }

// jsPDF embeds the sharp-rendered page as a FlateDecode image XObject with
// PNG predictor 15 (per-row filter bytes, RGB, 8 bits per component).
function unfilterPredictor(data: Buffer, width: number, height: number): Uint8Array {
  const bpp = 3
  const rowBytes = width * bpp
  const out = new Uint8Array(rowBytes * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = data[pos++]
    const rowStart = y * rowBytes
    const prevStart = rowStart - rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[pos++]
      const left = i >= bpp ? out[rowStart + i - bpp] : 0
      const up = y > 0 ? out[prevStart + i] : 0
      const upLeft = y > 0 && i >= bpp ? out[prevStart + i - bpp] : 0
      let v = raw
      if (filter === 1) v = (raw + left) & 0xff
      else if (filter === 2) v = (raw + up) & 0xff
      else if (filter === 3) v = (raw + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        v = (raw + predictor) & 0xff
      } else if (filter !== 0) throw new Error(`unsupported PNG predictor filter ${filter}`)
      out[rowStart + i] = v
    }
  }
  return out
}

async function pageInk(pdfPath: string): Promise<Ink> {
  const doc = await PDFDocument.load(readFileSync(pdfPath))
  const page = doc.getPage(0)
  const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
  if (!xobjects) throw new Error('official PDF page has no XObject resources')
  let best: { stream: PDFRawStream; width: number; height: number } | null = null
  for (const [, ref] of xobjects.entries()) {
    const stream: any = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const width = stream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()
    const height = stream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()
    if (width >= 700 && (!best || stream.contents.length > best.stream.contents.length)) best = { stream, width, height }
  }
  if (!best) throw new Error('official PDF page image not found')
  const pixels = unfilterPredictor(inflateSync(Buffer.from(best.stream.contents)), best.width, best.height)
  const mask = new Uint8Array(best.width * best.height)
  let count = 0
  for (let i = 0; i < best.width * best.height; i++) {
    const gray = (pixels[i * 3] + pixels[i * 3 + 1] + pixels[i * 3 + 2]) / 3
    if (gray < 128) { mask[i] = 1; count++ }
  }
  return { mask, count, width: best.width, height: best.height }
}

function jaccard(a: Ink, b: Ink): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] && b.mask[i]) inter++
    if (a.mask[i] || b.mask[i]) union++
  }
  return union ? inter / union : 0
}

function xorCount(a: Ink, b: Ink): number {
  let diff = 0
  for (let i = 0; i < a.mask.length; i++) if (a.mask[i] !== b.mask[i]) diff++
  return diff
}

function confWithDirs(dirs: string[]): string {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${dirs.map((d) => `  <dir>${d}</dir>`).join('\n')}\n</fontconfig>\n`
}

describe('official PDF fonts (production tofu regression)', () => {
  test(
    'embedded fonts render real Arabic text, and the Node code path matches them',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'official-fonts-test-'))
      const fontsDir = bundledStampFontsDir()
      const confs = {
        bundled: path.join(dir, 'bundled.conf'),
        empty: path.join(dir, 'empty.conf'),
      }
      writeFileSync(confs.bundled, stampFontsConfContent(fontsDir))
      writeFileSync(confs.empty, confWithDirs([]))

      const paths: Record<string, string> = {
        bundled: path.join(dir, 'bundled.pdf'),
        empty: path.join(dir, 'empty.pdf'),
        node: path.join(dir, 'node.pdf'),
      }
      const runs: Array<{ name: string; env: Record<string, string> }> = [
        { name: 'bundled', env: { FONTCONFIG_FILE: confs.bundled, XDG_CACHE_HOME: path.join(dir, 'cache-bundled') } },
        { name: 'empty', env: { FONTCONFIG_FILE: confs.empty, XDG_CACHE_HOME: path.join(dir, 'cache-empty') } },
      ]
      for (const run of runs) {
        const res = spawnSync(process.execPath, [HELPER, paths[run.name]], {
          cwd: REPO_ROOT,
          env: { ...process.env, ...run.env },
          encoding: 'utf8',
          timeout: 120000,
        })
        expect(res.status).toBe(0)
        expect(existsSync(paths[run.name])).toBe(true)
      }

      // Node path: no FONTCONFIG_FILE, so the ensureStampFonts() call inside
      // renderOfficialPdf must point fontconfig at the embedded fonts (the
      // production code path). FONTCONFIG_PATH holds an empty fonts.conf so
      // the default fontconfig finds no system fonts — the production
      // condition — on any machine, including font-rich CI runners.
      const noFontsDir = path.join(dir, 'nofonts')
      mkdirSync(noFontsDir, { recursive: true })
      writeFileSync(path.join(noFontsDir, 'fonts.conf'), confWithDirs([]))
      expect(existsSync(TSX)).toBe(true)
      const { FONTCONFIG_FILE: _dropped, ...envWithoutFontconfig } = process.env
      const nodeRes = spawnSync(TSX, [HELPER, paths.node], {
        cwd: REPO_ROOT,
        env: { ...envWithoutFontconfig, FONTCONFIG_PATH: noFontsDir, XDG_CACHE_HOME: path.join(dir, 'cache-node') },
        encoding: 'utf8',
        timeout: 120000,
      })
      expect(nodeRes.status).toBe(0)
      expect(existsSync(paths.node)).toBe(true)

      const bundled = await pageInk(paths.bundled)
      const empty = await pageInk(paths.empty)
      const node = await pageInk(paths.node)
      for (const img of [empty, node]) {
        expect(img.width).toBe(bundled.width)
        expect(img.height).toBe(bundled.height)
      }
      console.log(`[official-fonts] ink bundled=${bundled.count} empty=${empty.count} node=${node.count} jaccard(node,bundled)=${jaccard(node, bundled).toFixed(4)} jaccard(bundled,empty)=${jaccard(bundled, empty).toFixed(4)} xor(bundled,empty)=${xorCount(bundled, empty)}`)

      // The render must actually contain the designed page and its text.
      expect(bundled.count).toBeGreaterThan(5000)
      // The production code path under Node must match the embedded-font render.
      expect(jaccard(node, bundled)).toBeGreaterThan(0.9)
      // The embedded-font render must NOT be tofu: across a page full of
      // Arabic text, real glyphs differ from hollow boxes in a large number
      // of pixels (page chrome is identical in both, so this isolates text).
      expect(xorCount(bundled, empty)).toBeGreaterThan(4000)
    },
    180000,
  )
})
