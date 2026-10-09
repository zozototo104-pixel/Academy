import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { collectTimings, withServerTiming, withTiming } from '@/lib/timing'

export async function GET() {
  const { result, metrics } = await collectTimings(async () => {
    const user = await withTiming('auth_me_getCurrentUser', () => getCurrentUser())
    if (!user) return NextResponse.json({ user: null })
    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, country: user.country },
    })
  })
  return withServerTiming(result, metrics)
}
