#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const buildLogPath = process.argv[2] || 'next-build.log'
const trackedModules = ['AdminBooks', 'AdminExtras', 'AdminQualityTab', 'AdminView', 'AdminSystemTab']

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '')
}

function toBytes(size, unit) {
  const n = Number(size)
  if (!Number.isFinite(n)) return 0
  const normalized = String(unit || '').toLowerCase()
  if (normalized === 'mb') return n * 1024 * 1024
  if (normalized === 'kb') return n * 1024
  return n
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${Math.round(bytes)} B`
}

function parseRouteRows(log) {
  const rows = []
  for (const rawLine of String(log || '').split(/\r?\n/)) {
    const line = stripAnsi(rawLine)
    if (!line.includes('/')) continue
    if (/First Load JS shared by all/i.test(line)) continue
    const routeMatch = line.match(/[┌├└│\s]*(?:[○●ƒ◐]\s+)?(\/[\w@~.$+!*'(),;:%\-/\[\]{}=]+|\/)/)
    if (!routeMatch) continue
    const sizes = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(B|kB|MB)\b/g)]
    if (!sizes.length) continue
    const firstLoad = sizes[sizes.length - 1]
    rows.push({
      route: routeMatch[1],
      firstLoadJs: `${firstLoad[1]} ${firstLoad[2]}`,
      firstLoadBytes: toBytes(firstLoad[1], firstLoad[2]),
    })
  }
  return rows
}

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function chunkRows() {
  const roots = ['.next/static/chunks', '.next/server/chunks'].filter((dir) => fs.existsSync(dir))
  const files = roots.flatMap(walk)
  return files.map((file) => {
    const stat = fs.statSync(file)
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = ''
    }
    const matched = trackedModules.filter((name) => text.includes(name))
    return {
      file,
      relative: file.replace(/^\.next\//, '.next/'),
      bytes: stat.size,
      matched,
    }
  }).sort((a, b) => b.bytes - a.bytes)
}

function table(headers, rows) {
  const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const output = []
  output.push(`| ${headers.map(escape).join(' | ')} |`)
  output.push(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const row of rows) output.push(`| ${row.map(escape).join(' | ')} |`)
  return output.join('\n')
}

let log = ''
try {
  log = fs.readFileSync(buildLogPath, 'utf8')
} catch {
  log = ''
}

const routes = parseRouteRows(log)
const chunks = chunkRows()
const largestChunks = chunks.slice(0, 10)
const trackedRows = chunks
  .filter((chunk) => chunk.matched.length)
  .flatMap((chunk) => chunk.matched.map((moduleName) => [moduleName, chunk.relative, formatBytes(chunk.bytes)]))

const lines = []
lines.push('## Bundle report')
lines.push('')
lines.push('Build command used by this workflow: `ANALYZE=true bunx next build`. It intentionally does not run `bun run build`, because the package build script runs database/deployment scripts before `next build`.')
lines.push('')
lines.push('### First Load JS by route')
lines.push('')
if (routes.length) {
  lines.push(table(['Route', 'First Load JS'], routes.map((row) => [row.route, row.firstLoadJs])))
} else {
  lines.push('_No route size rows were found in the captured Next build output._')
}
lines.push('')
lines.push('### Largest JavaScript chunks')
lines.push('')
if (largestChunks.length) {
  lines.push(table(['Chunk', 'Size', 'Tracked admin modules found'], largestChunks.map((chunk) => [chunk.relative, formatBytes(chunk.bytes), chunk.matched.length ? chunk.matched.join(', ') : '—'])))
} else {
  lines.push('_No JavaScript chunks were found under `.next/static/chunks` or `.next/server/chunks`._')
}
lines.push('')
lines.push('### Tracked admin modules')
lines.push('')
if (trackedRows.length) {
  lines.push(table(['Module', 'Chunk', 'Chunk size'], trackedRows))
} else {
  lines.push(`_No chunk text matched: ${trackedModules.map((name) => `\`${name}\``).join(', ')}._`)
}
lines.push('')

process.stdout.write(`${lines.join('\n')}\n`)
