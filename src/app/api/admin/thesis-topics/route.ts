import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { geminiCompleteJson } from '@/lib/gemini'
import { enforceApiRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

function clean(value: unknown, max = 3000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseAiJson(text: string) {
  const raw = String(text || '').trim()
  try { return JSON.parse(raw) } catch {}
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

async function serializeProgram(programId: string) {
  return db.program.findUnique({
    where: { id: programId },
    select: {
      id: true,
      titleAr: true,
      titleEn: true,
      category: true,
      description: true,
      admissionRules: true,
      units: { select: { title: true, objectives: true, summary: true }, orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 30 },
      books: { select: { title: true, author: true, description: true, semester: true }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], take: 20 },
      knowledgeItems: { select: { title: true, summary: true, keywords: true }, orderBy: [{ importance: 'desc' }], take: 40 },
    },
  })
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId') || undefined
    const [programs, topics, requests] = await Promise.all([
      db.program.findMany({ where: { active: true }, select: { id: true, titleAr: true, category: true }, orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }] }),
      db.thesisTopic.findMany({
        where: programId ? { programId } : undefined,
        include: { program: { select: { titleAr: true } }, proposedBy: { select: { name: true, email: true } }, reviewedBy: { select: { name: true } }, _count: { select: { requests: true } } },
        orderBy: [{ createdAt: 'desc' }],
        take: 200,
      }),
      db.thesisTopicRequest.findMany({
        where: programId ? { programId } : undefined,
        include: { program: { select: { titleAr: true } }, user: { select: { name: true, email: true } }, topic: { select: { title: true } } },
        orderBy: [{ createdAt: 'desc' }],
        take: 100,
      }),
    ])
    return NextResponse.json({ programs, topics, requests })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin thesis topics GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل عناوين بحث التخرج' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-thesis-topics', 10, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json()
    const action = String(body?.action || 'create')
    const programId = clean(body?.programId, 120)
    if (!programId) return NextResponse.json({ error: 'اختر البرنامج أولًا' }, { status: 400 })

    if (action === 'generate') {
      const program = await serializeProgram(programId)
      if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
      const count = Math.max(3, Math.min(12, Number(body?.count || 6)))
      const prompt = `أنت لجنة أكاديمية. اقترح ${count} عناوين بحث تخرج مناسبة للبرنامج التالي. أعد JSON فقط بصيغة {"topics":[{"title":"...","description":"...","objectives":["..."],"methodology":"...","keywords":["..."]}]}.
البرنامج: ${program.titleAr}
الفئة: ${program.category}
الوصف: ${program.description}
الوحدات: ${program.units.map((u) => u.title).join(' | ')}
الكتب: ${program.books.map((b) => b.title).join(' | ')}
عناصر المعرفة: ${program.knowledgeItems.map((k) => k.title).join(' | ')}
الشروط: يجب أن تكون العناوين تطبيقية، قابلة للتنفيذ خلال مدة البرنامج، وغير عامة، ومناسبة لمستوى البرنامج.`
      const text = await geminiCompleteJson({
        system: 'أنت مساعد أكاديمي متخصص في اقتراح عناوين بحوث تخرج. أعد JSON صالحاً فقط دون شرح إضافي.',
        history: [{ role: 'user', text: prompt }],
        temperature: 0.45,
        maxOutputTokens: 3000,
      })
      const parsed = parseAiJson(text)
      const topics = Array.isArray(parsed?.topics) ? parsed.topics : Array.isArray(parsed) ? parsed : []
      const created: any[] = []
      for (const t of topics.slice(0, count)) {
        const title = clean(t?.title, 260)
        if (!title) continue
        created.push(await db.thesisTopic.create({
          data: {
            programId,
            title,
            description: clean(t?.description, 2000) || null,
            objectives: Array.isArray(t?.objectives) ? JSON.stringify(t.objectives.slice(0, 8)) : clean(t?.objectives, 1500) || null,
            methodology: clean(t?.methodology, 1500) || null,
            keywords: Array.isArray(t?.keywords) ? JSON.stringify(t.keywords.slice(0, 12)) : clean(t?.keywords, 800) || null,
            source: 'AI',
            status: 'NEEDS_REVIEW',
            proposedById: admin.id,
          },
        }))
      }
      await audit({ id: admin.id, name: admin.name }, 'GENERATE_THESIS_TOPICS', 'Program', programId, `توليد ${created.length} مقترح عنوان بحث تخرج`)
      return NextResponse.json({ ok: true, created })
    }

    const title = clean(body?.title, 260)
    if (!title) return NextResponse.json({ error: 'عنوان البحث مطلوب' }, { status: 400 })
    const topic = await db.thesisTopic.create({
      data: {
        programId,
        title,
        description: clean(body?.description, 2000) || null,
        objectives: clean(body?.objectives, 2000) || null,
        methodology: clean(body?.methodology, 1500) || null,
        keywords: clean(body?.keywords, 800) || null,
        source: 'ADMIN',
        status: body?.status || 'APPROVED',
        proposedById: admin.id,
        reviewedById: admin.id,
        reviewedAt: new Date(),
      },
    })
    await audit({ id: admin.id, name: admin.name }, 'CREATE_THESIS_TOPIC', 'ThesisTopic', topic.id, `إضافة عنوان بحث تخرج: ${title}`)
    return NextResponse.json({ ok: true, topic })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin thesis topics POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر حفظ عناوين بحث التخرج' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    if (body?.requestId) {
      const reqItem = await db.thesisTopicRequest.update({
        where: { id: String(body.requestId) },
        data: { status: body.status || 'PENDING', adminNote: clean(body.adminNote, 1500) || null, reviewedById: admin.id, reviewedAt: new Date() },
      })
      return NextResponse.json({ ok: true, request: reqItem })
    }
    const id = String(body?.id || '')
    if (!id) return NextResponse.json({ error: 'معرف العنوان مطلوب' }, { status: 400 })
    const topic = await db.thesisTopic.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: clean(body.title, 260) } : {}),
        ...(body.description !== undefined ? { description: clean(body.description, 2000) || null } : {}),
        ...(body.objectives !== undefined ? { objectives: clean(body.objectives, 2000) || null } : {}),
        ...(body.methodology !== undefined ? { methodology: clean(body.methodology, 1500) || null } : {}),
        ...(body.keywords !== undefined ? { keywords: clean(body.keywords, 800) || null } : {}),
        ...(body.status !== undefined ? { status: clean(body.status, 40), reviewedById: admin.id, reviewedAt: new Date() } : {}),
      },
    })
    return NextResponse.json({ ok: true, topic })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin thesis topics PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث عنوان بحث التخرج' }, { status: 500 })
  }
}
