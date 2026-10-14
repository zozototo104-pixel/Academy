import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { handleRepresentativeVerifyGet, handleRepresentativeVerifyPost } from '@/lib/representative-verification'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleRepresentativeVerifyGet(req, token, db)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleRepresentativeVerifyPost(req, token, db)
}
