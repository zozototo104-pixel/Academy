// check-ai-router-coverage.ts — CI grep-guard (step 7).
//
// Fails (exit 1) if a non-allowlisted file calls a provider directly.
// "Through the router" = textAiComplete* in src/lib/text-ai.ts.
// "Governed shim" = geminiComplete* / geminiVisionJson in src/lib/gemini.ts.
// Everything else that touches a provider SDK or a provider URL is a
// bypass unless it is on the allowlist below with a recorded reason.
//
// Usage: bun scripts/check-ai-router-coverage.ts
// (also covered by tests/ai/auto-router-coverage.test.ts, which imports
// checkAiRouterCoverage() and asserts zero violations on this tree plus
// that a synthetic violation is detected.)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface CoverageViolation {
  file: string
  line: number
  pattern: string
  text: string
}

export interface CoverageCheckResult {
  checkedFiles: number
  violations: CoverageViolation[]
}

// pattern -> files allowed to match it (relative to the repo root),
// with the plan §(e) bypass number / reason for each entry.
const ALLOWLIST: Record<string, Record<string, string>> = {
  'new GoogleGenAI(': {
    'src/lib/text-ai.ts': 'router (B16, native Gemini branch inside callProvider)',
    'src/lib/gemini.ts': 'governed shim (B1/B2/B3 native fallback)',
    'src/lib/asr.ts': 'ASR only (B8, Gemini Files-API transcription protocol)',
    'src/lib/voice/geminiLiveAgent.ts': 'Live voice SDK session (B9, native protocol)',
  },
  geminiVisionJson: {
    'src/lib/gemini.ts': 'governed shim definition (B3)',
    'src/lib/book-content.ts': 'vision reads via the governed shim (B11)',
    'src/lib/knowledge-bank.ts': 'vision reads via the governed shim (B3)',
  },
  'zai.chat': {
    'src/lib/text-ai.ts': 'router (B15, router ZAI branch inside callProvider)',
    'src/lib/ai.ts': 'direct ZAI last resort — kept ONLY when auto mode is OFF (B4, step 7e)',
  },
  'z-ai-web-dev-sdk': {
    'src/lib/ai.ts': 'direct ZAI SDK import — kept ONLY when auto mode is OFF (B4, step 7e)',
  },
  'generativelanguage.googleapis.com': {
    'src/lib/text-ai.ts': 'router (Gemini /models discovery + generateContent)',
    'src/lib/gemini.ts': 'governed shim (native Gemini fallback)',
    'src/lib/meeting-assistant.ts': 'Live auth-token fetch + Live WebSocket URL (B9, stays native)',
    'src/app/api/admin/launch-quality/route.ts': 'Live token probe (B9, native protocol)',
    'src/app/api/admin/system/route.ts': 'Live token health check (B9, native protocol)',
    'src/app/api/ai/gemini-live/session/route.ts': 'Live session token + WebSocket URL (B9, native protocol)',
  },
  'api.openai.com': {
    'src/lib/text-ai.ts': 'router (OpenAI base URL default + call branch)',
    // Config-default strings, not calls — and the ASR Whisper endpoint.
    'src/lib/asr.ts': 'Whisper-compatible ASR endpoint default (B8)',
    'src/components/aact/AdminSystemTab.tsx': 'admin UI default-value string for OPENAI_BASE_URL (not a call)',
  },
  'api.anthropic.com': {
    'src/lib/text-ai.ts': 'router (Anthropic /models discovery + /messages call branch)',
  },
  'api.z.ai': {
    'src/lib/text-ai.ts': 'router (ZAI base URL default + call branch)',
    'src/components/aact/AdminSystemTab.tsx': 'admin UI default-value string for ZAI_API_BASE (not a call)',
  },
}

const PATTERNS = Object.keys(ALLOWLIST)

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      walk(path, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path)
    }
  }
}

export function checkAiRouterCoverage(rootDir: string): CoverageCheckResult {
  const srcDir = join(rootDir, 'src')
  const files: string[] = []
  walk(srcDir, files)
  const violations: CoverageViolation[] = []
  for (const file of files) {
    const rel = relative(rootDir, file).split('\\').join('/')
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    for (const pattern of PATTERNS) {
      const allowed = ALLOWLIST[pattern] || {}
      if (rel in allowed) continue
      lines.forEach((line, index) => {
        if (line.includes(pattern)) {
          violations.push({ file: rel, line: index + 1, pattern, text: line.trim().slice(0, 160) })
        }
      })
    }
  }
  return { checkedFiles: files.length, violations }
}

if (import.meta.main) {
  const rootDir = join(import.meta.dir, '..')
  const result = checkAiRouterCoverage(rootDir)
  if (!result.violations.length) {
    console.log(`AI router coverage OK: ${result.checkedFiles} files checked, 0 direct-provider violations.`)
    process.exit(0)
  }
  console.error(`AI router coverage FAILED: ${result.violations.length} violation(s) in ${result.checkedFiles} files:`)
  for (const v of result.violations) {
    console.error(`- ${v.file}:${v.line} [${v.pattern}] ${v.text}`)
  }
  console.error('Add the file to the allowlist in scripts/check-ai-router-coverage.ts with a plan §(e) reason — or route it through textAiComplete* / the governed shim.')
  process.exit(1)
}
