/**
 * VoiceStateMachine — مصدر الحقيقة الوحيد لحالة الجلسة الصوتية.
 * الحالات: IDLE → LISTENING ⇄ USER_SPEAKING → THINKING → AI_SPEAKING
 *          AI_SPEAKING → INTERRUPTED → LISTENING
 * كل التغييرات تمر عبر transition() الذي يرفض الانتقالات غير المشروعة
 * ويبث حدث change للمشتركين (الواجهة، المحرك، المؤثرات).
 */
export type VoiceState = 'IDLE' | 'LISTENING' | 'USER_SPEAKING' | 'THINKING' | 'AI_SPEAKING' | 'INTERRUPTED'

const ALLOWED: Record<VoiceState, VoiceState[]> = {
  IDLE: ['LISTENING'],
  LISTENING: ['USER_SPEAKING', 'THINKING', 'IDLE'],
  USER_SPEAKING: ['THINKING', 'LISTENING', 'IDLE'],
  THINKING: ['AI_SPEAKING', 'LISTENING', 'IDLE'],
  AI_SPEAKING: ['INTERRUPTED', 'LISTENING', 'IDLE', 'THINKING'],
  INTERRUPTED: ['LISTENING', 'IDLE', 'THINKING'],
}

export class VoiceStateMachine {
  private state: VoiceState = 'IDLE'
  private since = 0
  private listeners = new Set<(s: VoiceState, prev: VoiceState, heldMs: number) => void>()

  get current(): VoiceState {
    return this.state
  }

  onChange(fn: (s: VoiceState, prev: VoiceState, heldMs: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** يحاول الانتقال — يعيد true إذا نجح */
  to(next: VoiceState): boolean {
    if (next === this.state) return true
    if (!ALLOWED[this.state].includes(next)) {
      console.debug(`[VOICE-FSM] rejected ${this.state} → ${next}`)
      return false
    }
    const prev = this.state
    const heldMs = Date.now() - this.since
    this.state = next
    this.since = Date.now()
    console.debug(`[VOICE-FSM] ${prev} → ${next}`)
    this.listeners.forEach((fn) => fn(next, prev, heldMs))
    return true
  }

  is(...states: VoiceState[]): boolean {
    return states.includes(this.state)
  }

  reset() {
    this.state = 'IDLE'
    this.since = Date.now()
    this.listeners.forEach((fn) => fn('IDLE', 'IDLE', 0))
  }
}
