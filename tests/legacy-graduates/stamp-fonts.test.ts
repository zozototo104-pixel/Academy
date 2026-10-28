/// <reference types="bun-types" />
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { describe, expect, test } from 'bun:test'
import { bundledStampFontsDir, stampFontsConfContent } from '@/lib/legacy-certificate-files'

// Production previews rendered every stamp text field as tofu boxes because
// the rendering server had no usable font. The app now embeds the fonts the
// stamp SVG asks for. This test renders the real overlay in three isolated
// environments (see render-stamp-overlay-fixture.ts) and compares pixels.
//
// Deliberately, NOTHING here is compared against the machine's own system
// fonts: those differ between machines (CI's font set resolved the same
// text very differently from this sandbox), so such a comparison is flaky
// by construction. Instead the test asserts two environment-independent
// facts, and only both together can pass:
//   1. the production code path under Node (ensureStampFonts) renders
//      exactly like the embedded-font render (same fonts, same config);
//   2. the embedded-font render is real text, not tofu (it must differ
//      sharply from the fontless render).
// If the embedded fonts broke, (2) would fail (bundled render == tofu).
// If ensureStampFonts broke, (1) would fail. A blank render fails both.
//
// Fontconfig is driven via the parent spawn environment on purpose: setting
// FONTCONFIG_FILE inside a bun process does not reach fontconfig, while a
// parent-provided environment does. The tsx/Node run covers
// ensureStampFonts() itself, which is the production (Node) code path.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const HELPER = path.join(HERE, 'render-stamp-overlay-fixture.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

type Ink = { mask: Uint8Array; count: number; width: number; height: number }

async function inkMask(pngPath: string): Promise<Ink> {
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const mask = new Uint8Array(width * height)
  let count = 0
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    const alpha = channels === 4 ? data[o + 3] : 255
    const gray = (data[o] + data[o + 1] + data[o + 2]) / 3
    if (alpha > 128 && gray < 128) {
      mask[i] = 1
      count++
    }
  }
  return { mask, count, width, height }
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

function confWithDirs(dirs: string[]): string {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${dirs.map((d) => `  <dir>${d}</dir>`).join('\n')}\n</fontconfig>\n`
}

describe('legacy certificate stamp fonts', () => {
  test(
    'embedded fonts render real text, and the Node code path matches them',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'stamp-fonts-test-'))
      const fontsDir = bundledStampFontsDir()
      const confs = {
        bundled: path.join(dir, 'bundled.conf'),
        empty: path.join(dir, 'empty.conf'),
      }
      writeFileSync(confs.bundled, stampFontsConfContent(fontsDir))
      writeFileSync(confs.empty, confWithDirs([]))

      const paths: Record<string, string> = {
        bundled: path.join(dir, 'bundled.png'),
        empty: path.join(dir, 'empty.png'),
        node: path.join(dir, 'node.png'),
      }
      const runs: Array<{ name: string; cmd: string; args: string[]; env: Record<string, string | undefined> }> = [
        {
          name: 'bundled',
          cmd: process.execPath,
          args: [HELPER, paths.bundled],
          env: { FONTCONFIG_FILE: confs.bundled, XDG_CACHE_HOME: path.join(dir, 'cache-bundled') },
        },
        {
          name: 'empty',
          cmd: process.execPath,
          args: [HELPER, paths.empty],
          env: { FONTCONFIG_FILE: confs.empty, XDG_CACHE_HOME: path.join(dir, 'cache-empty') },
        },
      ]
      for (const run of runs) {
        const res = spawnSync(run.cmd, run.args, {
          cwd: REPO_ROOT,
          env: { ...process.env, ...run.env },
          encoding: 'utf8',
          timeout: 120000,
        })
        expect(res.status).toBe(0)
        expect(existsSync(paths[run.name])).toBe(true)
      }

      // Node path: no FONTCONFIG_FILE, so ensureStampFonts() itself must
      // point fontconfig at the embedded fonts (the production code path).
      expect(existsSync(TSX)).toBe(true)
      const { FONTCONFIG_FILE: _dropped, ...envWithoutFontconfig } = process.env
      const nodeRes = spawnSync(TSX, [HELPER, paths.node], {
        cwd: REPO_ROOT,
        env: { ...envWithoutFontconfig, XDG_CACHE_HOME: path.join(dir, 'cache-node') },
        encoding: 'utf8',
        timeout: 120000,
      })
      expect(nodeRes.status).toBe(0)
      expect(existsSync(paths.node)).toBe(true)

      const bundled = await inkMask(paths.bundled)
      const empty = await inkMask(paths.empty)
      const node = await inkMask(paths.node)
      for (const img of [empty, node]) {
        expect(img.width).toBe(bundled.width)
        expect(img.height).toBe(bundled.height)
      }

      // The render must actually contain text ink (guards against a blank render).
      expect(bundled.count).toBeGreaterThan(1000)
      // The production code path under Node must match the embedded-font render.
      expect(jaccard(node, bundled)).toBeGreaterThan(0.9)
      // The embedded-font render must NOT be tofu: it must differ sharply
      // from the fontless render.
      expect(jaccard(bundled, empty)).toBeLessThan(0.3)
    },
    180000,
  )
})
