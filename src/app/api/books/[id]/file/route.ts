import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// Legacy compatibility route: keep /api/books/:id/file working, but force it
// through the canonical /download route where enrollment/admin checks live.
export async function GET(req: NextRequest, context: RouteContext) {
  const { id } = await Promise.resolve(context.params)
  if (!id) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })

  const url = new URL(req.url)
  url.pathname = `/api/books/${encodeURIComponent(id)}/download`
  return NextResponse.redirect(url, { status: 307 })
}
