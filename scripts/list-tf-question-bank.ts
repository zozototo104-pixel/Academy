import { db } from '@/lib/db'

function oneLine(value: unknown, max = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function main() {
  const questions = await db.questionBankItem.findMany({
    where: { type: 'TF' },
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true,
      programId: true,
      unitId: true,
      status: true,
      correctAnswer: true,
      options: true,
      text: true,
      sourceEvidence: true,
      sourceLocator: true,
      createdAt: true,
    },
  })
  console.log(`TF_QUESTION_BANK_COUNT=${questions.length}`)
  for (const q of questions) {
    console.log(JSON.stringify({
      id: q.id,
      programId: q.programId,
      unitId: q.unitId,
      status: q.status,
      correctAnswer: q.correctAnswer,
      options: q.options,
      text: oneLine(q.text),
      sourceEvidence: oneLine(q.sourceEvidence, 600),
      sourceLocator: q.sourceLocator,
      createdAt: q.createdAt.toISOString(),
    }, null, 2))
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
