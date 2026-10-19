import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { buildRelevantSupervisorBookSnippets } from '@/lib/supervisor-ai'

export const runtime = 'nodejs'
export const maxDuration = 10

const BOOK_SEARCH_QUERY_MAX = 300
const BOOK_SEARCH_SNIPPETS_MAX = 4000

function cleanQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim().slice(0, BOOK_SEARCH_QUERY_MAX)
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
  }

  const limit = enforceApiRateLimit(req, 'ai:book-search', 30, 10 * 60 * 1000, user.id)
  if (limit) return limit

  let body: { query?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'صيغة الطلب غير صحيحة' }, { status: 400 })
  }

  if (typeof body.query !== 'string') {
    return NextResponse.json({ error: 'query مطلوب كنص' }, { status: 400 })
  }
  if (body.query.length > BOOK_SEARCH_QUERY_MAX) {
    return NextResponse.json({ error: 'query أطول من الحد المسموح' }, { status: 400 })
  }

  const query = cleanQuery(body.query)
  if (!query) return NextResponse.json({ snippets: '' })

  const enrollments = await db.enrollment.findMany({
    where: {
      userId: user.id,
      status: { in: ['ACTIVE', 'COMPLETED'] },
    },
    select: { programId: true },
  }).catch(() => [])

  const programIds = [...new Set(
    (Array.isArray(enrollments) ? enrollments : [])
      .map((enrollment: any) => String(enrollment?.programId || '').trim())
      .filter(Boolean)
  )]

  if (!programIds.length) return NextResponse.json({ snippets: '' })

  const snippets = await buildRelevantSupervisorBookSnippets(programIds, query, 2500).catch(() => '')
  return NextResponse.json({ snippets: String(snippets || '').slice(0, BOOK_SEARCH_SNIPPETS_MAX) })
}
