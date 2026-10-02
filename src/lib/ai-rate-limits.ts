import { NextRequest, NextResponse } from 'next/server'
import { enforceApiRateLimit } from '@/lib/rate-limit'

type AiRateLimitProfile = {
  scope: string
  limit: number
  windowMs: number
}

const MINUTE = 60_000

export const AI_RATE_LIMITS = {
  asr: { scope: 'ai:asr', limit: 8, windowMs: 10 * MINUTE },
  tts: { scope: 'ai:tts', limit: 12, windowMs: 10 * MINUTE },
  ttsStream: { scope: 'ai:tts-stream', limit: 16, windowMs: 10 * MINUTE },
  voiceStream: { scope: 'ai:voice-stream', limit: 20, windowMs: 10 * MINUTE },
  defense: { scope: 'ai:defense', limit: 18, windowMs: 10 * MINUTE },
  defenseRecording: { scope: 'ai:defense-recording', limit: 4, windowMs: 60 * MINUTE },
} satisfies Record<string, AiRateLimitProfile>

export function enforceUserAiRateLimit(
  req: NextRequest,
  profile: AiRateLimitProfile,
  userId: string
): NextResponse | null {
  return enforceApiRateLimit(req, profile.scope, profile.limit, profile.windowMs, userId)
}

export function base64DecodedSize(value: string): number {
  const clean = String(value || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '')
  if (!clean) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}
