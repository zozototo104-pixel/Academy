import assert from 'node:assert/strict'
import { __setAiTaskPauseStoreForTests, clearAiTaskPause, getAiTaskPause, setAiTaskPause } from '../src/lib/ai-task-pause'

async function main() {
  console.log('▶ AI task pause helpers do not throw when storage fails')

  const failingStore = {
    async upsert() { throw new Error('db down') },
    async find() { throw new Error('db down') },
    async delete() { throw new Error('db down') },
  }

  __setAiTaskPauseStoreForTests(failingStore)
  try {
    const payload = await setAiTaskPause('QUESTION_BANK', 'program-1', {
      code: 'AI_ACADEMIC_PROVIDER_UNAVAILABLE',
      reason: 'providers cooling down',
      retryAt: '2030-01-01T00:00:00.000Z',
    })
    assert.equal(payload.code, 'AI_ACADEMIC_PROVIDER_UNAVAILABLE')
    assert.equal(payload.reason, 'providers cooling down')
    assert.equal(payload.retryAt, '2030-01-01T00:00:00.000Z')
    assert.ok(payload.pausedAt)

    const pause = await getAiTaskPause('QUESTION_BANK', 'program-1')
    assert.equal(pause, null)

    await clearAiTaskPause('QUESTION_BANK', 'program-1')
  } finally {
    __setAiTaskPauseStoreForTests(null)
  }

  console.log('AI task pause helpers: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  __setAiTaskPauseStoreForTests(null)
})
