import { buildScopedDirectProgramBooksResult } from '@/lib/ai-context-builder'
import type { AiKnowledgeScope } from '@/lib/ai-knowledge-policy'

const CHECKS: Array<{ scope: AiKnowledgeScope; query: string; minSelected?: number }> = [
  { scope: 'ADMIN_ASSISTANT', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
  { scope: 'HUMAN_SUPERVISOR', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
  { scope: 'PUBLIC_VISITOR', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
]

function fail(message: string): never {
  console.error(`\n[ai-knowledge-check] FAILED: ${message}`)
  process.exit(1)
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

async function main() {
  console.log('[ai-knowledge-check] Starting central AI knowledge grounding checks...')

  for (const check of CHECKS) {
    const result = await buildScopedDirectProgramBooksResult(check.query, check.scope)
    const diagnostics = result.diagnostics
    console.log(`\n[ai-knowledge-check] scope=${check.scope}`)
    console.log(JSON.stringify({
      reason: diagnostics.reason,
      totalPrograms: diagnostics.totalPrograms,
      matchedPrograms: diagnostics.matchedPrograms,
      matchedProgramsWithBooks: diagnostics.matchedProgramsWithBooks,
      selectedPrograms: diagnostics.selectedPrograms,
      returnedReply: diagnostics.returnedReply,
    }, null, 2))

    assertCondition(diagnostics.scope === check.scope, `Unexpected scope for ${check.scope}`)
    assertCondition(diagnostics.source === 'SCOPED_PROGRAM_CATALOG', `Unexpected diagnostics source for ${check.scope}`)
    assertCondition(diagnostics.totalPrograms > 0, `No active programs loaded for ${check.scope}`)
    assertCondition(diagnostics.returnedReply === true, `No direct grounded reply returned for ${check.scope}`)
    assertCondition(result.reply && result.reply.includes('حسب قاعدة بيانات المنصة الحالية'), `Reply is not clearly database-grounded for ${check.scope}`)
    assertCondition(diagnostics.selectedPrograms.length >= (check.minSelected || 1), `No selected matching programs for ${check.scope}`)
    assertCondition(diagnostics.selectedPrograms.some((program) => program.booksCount > 0), `Selected programs have no registered books for ${check.scope}`)
  }

  console.log('\n[ai-knowledge-check] OK: central AI knowledge builder returned grounded program/book answers for all checked scopes.')
}

main().catch((error) => {
  console.error('[ai-knowledge-check] Unexpected error:', error)
  process.exit(1)
})
