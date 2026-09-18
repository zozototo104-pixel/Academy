import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createHmac, randomBytes } from 'crypto'

const STATE_COOKIE = 'aact_google_oauth_state'

function oauthSecret() {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_ID || 'aact-google-oauth'
}

function signState(nonce: string, ts: number) {
  return createHmac('sha256', oauthSecret()).update(`${nonce}.${ts}`).digest('base64url')
}

function createSignedState() {
  const nonce = randomBytes(24).toString('hex')
  const ts = Date.now()
  return `${nonce}.${ts}.${signState(nonce, ts)}`
}

function appBaseUrl(req: NextRequest) {
  const configured = process.env.NEXTAUTH_URL || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/$/, '')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  return `${proto}://${host}`.replace(/\/$/, '')
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    return NextResponse.redirect(new URL('/?view=auth&oauth_error=google_not_configured', req.url))
  }

  const state = createSignedState()
  const baseUrl = appBaseUrl(req)
  const redirectUri = `${baseUrl}/api/auth/google/callback`
  const store = await cookies()
  store.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 10 * 60,
  })

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'openid email profile')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('prompt', 'select_account')

  return NextResponse.redirect(authUrl)
}
