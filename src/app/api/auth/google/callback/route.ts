import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { createSession, hashPassword } from '@/lib/auth'

const STATE_COOKIE = 'aact_google_oauth_state'

function appBaseUrl(req: NextRequest) {
  const configured = process.env.NEXTAUTH_URL || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/$/, '')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  return `${proto}://${host}`.replace(/\/$/, '')
}

function authRedirect(req: NextRequest, params: Record<string, string>) {
  const url = new URL('/?view=auth', appBaseUrl(req))
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

async function exchangeCode(req: NextRequest, code: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('GOOGLE_NOT_CONFIGURED')

  const redirectUri = `${appBaseUrl(req)}/api/auth/google/callback`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(data?.error_description || data?.error || 'TOKEN_EXCHANGE_FAILED')
  return String(data.access_token)
}

async function fetchGoogleProfile(accessToken: string) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.email) throw new Error('GOOGLE_PROFILE_FAILED')
  return {
    email: String(data.email).toLowerCase().trim(),
    name: String(data.name || data.email).trim(),
    emailVerified: data.email_verified !== false,
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const store = await cookies()
  const expectedState = store.get(STATE_COOKIE)?.value
  store.delete(STATE_COOKIE)

  if (error) return authRedirect(req, { oauth_error: error })
  if (!code || !state || !expectedState || state !== expectedState) {
    return authRedirect(req, { oauth_error: 'invalid_state' })
  }

  try {
    const accessToken = await exchangeCode(req, code)
    const profile = await fetchGoogleProfile(accessToken)
    if (!profile.emailVerified) return authRedirect(req, { oauth_error: 'email_not_verified' })

    const existing = await db.user.findUnique({ where: { email: profile.email } })
    const user = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: { name: existing.name || profile.name },
        })
      : await db.user.create({
          data: {
            email: profile.email,
            name: profile.name,
            password: hashPassword(`google:${randomBytes(32).toString('hex')}`),
            role: 'STUDENT',
          },
        })

    const token = await createSession(user.id)
    const target = new URL('/', appBaseUrl(req))
    target.searchParams.set('authToken', token)
    target.searchParams.set('view', user.role === 'ADMIN' ? 'admin' : user.role === 'SUPERVISOR' ? 'supervisor' : 'dashboard')
    target.searchParams.set('oauth', 'google')
    return NextResponse.redirect(target)
  } catch (e) {
    console.error('Google OAuth callback failed:', e)
    return authRedirect(req, { oauth_error: 'google_login_failed' })
  }
}
