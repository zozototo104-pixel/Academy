export const STREAM_INTERRUPTED_RETRY_MESSAGE = '\n\nانقطع الرد، أعد المحاولة.'

export async function* streamWithNoFallbackAfterFirstChunk(
  primary: () => AsyncIterable<string>,
  fallback?: () => AsyncIterable<string>,
): AsyncGenerator<string> {
  let emitted = false
  try {
    for await (const chunk of primary()) {
      emitted = emitted || Boolean(chunk)
      yield chunk
    }
    return
  } catch (error) {
    if (emitted) {
      yield STREAM_INTERRUPTED_RETRY_MESSAGE
      return
    }
    if (!fallback) throw error
  }
  if (fallback) {
    for await (const chunk of fallback()) yield chunk
  }
}
