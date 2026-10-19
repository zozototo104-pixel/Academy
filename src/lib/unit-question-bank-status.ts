export function resolveUnitQuestionBankJobStatus({
  jobStatus,
  approved,
  required,
}: {
  jobStatus: string
  approved: number
  required: number
}) {
  const approvedCount = Math.max(0, Math.floor(Number(approved || 0)))
  const requiredCount = Math.max(0, Math.floor(Number(required || 0)))
  if (requiredCount > 0 && approvedCount >= requiredCount) return 'COMPLETED'
  return jobStatus
}
