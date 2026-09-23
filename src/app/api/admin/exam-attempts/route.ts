import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const status = cleanAdminQuery(sp.get('status'))
    const filters: any[] = []
    if (status === 'PASSED') filters.push({ passed: true })
    else if (status === 'FAILED') filters.push({ passed: false })
    else if (status === 'UNSCORED') filters.push({ passed: null })
    else if (status && status !== 'ALL') filters.push({ status })
    if (search) {
      filters.push({
        OR: [
          { user: { name: { contains: search, mode: 'insensitive' } } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
          { exam: { title: { contains: search, mode: 'insensitive' } } },
          { exam: { unit: { title: { contains: search, mode: 'insensitive' } } } },
          { exam: { unit: { program: { titleAr: { contains: search, mode: 'insensitive' } } } } },
        ],
      })
    }
    const where: any = filters.length ? { AND: filters } : {}
    const [attempts, total] = await Promise.all([
      db.examAttempt.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { name: true, email: true } },
          exam: { include: { unit: { select: { title: true, program: { select: { titleAr: true } } } } } },
        },
      }),
      db.examAttempt.count({ where }),
    ])
    return NextResponse.json({
      attempts: attempts.map((a) => ({
        id: a.id,
        student: a.user.name,
        email: a.user.email,
        exam: a.exam?.title || '',
        unit: a.exam?.unit?.title || '',
        program: a.exam?.unit?.program?.titleAr || '',
        score: a.score,
        passed: a.passed,
        status: a.status,
        submittedAt: a.submittedAt,
      })),
      total,
      pagination: adminPaginationMeta(page, pageSize, total),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin exam attempts GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل نتائج الامتحانات' }, { status: 500 })
  }
}
