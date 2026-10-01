import { buildScopedDirectProgramBooksResult } from '@/lib/ai-context-builder'
import { getAiKnowledgePolicy, resolveAiKnowledgeScope, type AiKnowledgeScope } from '@/lib/ai-knowledge-policy'

const CHECKS: Array<{ scope: AiKnowledgeScope; query: string; minSelected?: number }> = [
  { scope: 'ADMIN_ASSISTANT', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
  { scope: 'HUMAN_SUPERVISOR', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
  { scope: 'PUBLIC_VISITOR', query: 'شو الكتب المقررة في الماجستير؟', minSelected: 1 },
]

const SCOPE_RESOLUTION_CHECKS: Array<{ label: string; input: Parameters<typeof resolveAiKnowledgeScope>[0]; expected: AiKnowledgeScope }> = [
  { label: 'admin text', input: { role: 'ADMIN', mode: 'TEXT' }, expected: 'ADMIN_ASSISTANT' },
  { label: 'human supervisor text', input: { role: 'SUPERVISOR', mode: 'TEXT' }, expected: 'HUMAN_SUPERVISOR' },
  { label: 'student supervisor', input: { role: 'STUDENT', mode: 'TEXT' }, expected: 'STUDENT_SUPERVISOR' },
  { label: 'whatsapp public visitor', input: { channel: 'WHATSAPP' }, expected: 'WHATSAPP_VISITOR' },
  { label: 'defense session', input: { role: 'STUDENT', purpose: 'DISCUSSION' }, expected: 'DEFENSE_EXAMINER' },
  { label: 'exam mode', input: { role: 'STUDENT', mode: 'EXAM' }, expected: 'EXAM_ASSISTANT' },
  { label: 'anonymous visitor', input: {}, expected: 'PUBLIC_VISITOR' },
]

function fail(message: string): never {
  console.error(`\n[ai-knowledge-check] FAILED: ${message}`)
  process.exit(1)
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

function checkScopeResolutionAndPolicies() {
  console.log('\n[ai-knowledge-check] Checking AI knowledge scope resolver and policy boundaries...')

  for (const item of SCOPE_RESOLUTION_CHECKS) {
    const actual = resolveAiKnowledgeScope(item.input)
    console.log(`[ai-knowledge-check] resolver ${item.label}: ${actual}`)
    assertCondition(actual === item.expected, `Scope resolver mismatch for ${item.label}: expected ${item.expected}, got ${actual}`)
  }

  const publicPolicy = getAiKnowledgePolicy('PUBLIC_VISITOR')
  assertCondition(publicPolicy.canReadPublicCatalog === true, 'PUBLIC_VISITOR should read public catalog')
  assertCondition(publicPolicy.canReadAdminIndicators === false, 'PUBLIC_VISITOR must not read admin indicators')
  assertCondition(publicPolicy.canReadFinancialIndicators === false, 'PUBLIC_VISITOR must not read financial indicators')
  assertCondition(publicPolicy.canReadAssignedStudents === false, 'PUBLIC_VISITOR must not read assigned students')

  const whatsappPolicy = getAiKnowledgePolicy('WHATSAPP_VISITOR')
  assertCondition(whatsappPolicy.canReadWhatsAppThread === true, 'WHATSAPP_VISITOR should read its WhatsApp thread context')
  assertCondition(whatsappPolicy.canReadAdminIndicators === false, 'WHATSAPP_VISITOR must not read admin indicators')

  const supervisorPolicy = getAiKnowledgePolicy('HUMAN_SUPERVISOR')
  assertCondition(supervisorPolicy.canReadAssignedStudents === true, 'HUMAN_SUPERVISOR should read assigned students')
  assertCondition(supervisorPolicy.canReadFinancialIndicators === false, 'HUMAN_SUPERVISOR must not read financial indicators')
  assertCondition(supervisorPolicy.canReadAdminIndicators === false, 'HUMAN_SUPERVISOR must not read admin indicators')

  const adminPolicy = getAiKnowledgePolicy('ADMIN_ASSISTANT')
  assertCondition(adminPolicy.canReadAdminIndicators === true, 'ADMIN_ASSISTANT should read admin indicators')
  assertCondition(adminPolicy.canReadFinancialIndicators === true, 'ADMIN_ASSISTANT should read financial indicators')
  assertCondition(adminPolicy.canReadProgramBooks === true, 'ADMIN_ASSISTANT should read program books')

  const defensePolicy = getAiKnowledgePolicy('DEFENSE_EXAMINER')
  assertCondition(defensePolicy.canReadDefenseContext === true, 'DEFENSE_EXAMINER should read defense context')
  assertCondition(defensePolicy.canReadFinancialIndicators === false, 'DEFENSE_EXAMINER must not read financial indicators')

  console.log('[ai-knowledge-check] OK: scope resolver and policy boundaries are consistent.')
}

async function main() {
  console.log('[ai-knowledge-check] Starting central AI knowledge grounding checks...')
  checkScopeResolutionAndPolicies()

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
