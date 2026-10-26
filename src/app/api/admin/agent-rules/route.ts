import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getSettingJson } from '@/lib/settings'
import { DEFAULT_AGENT_DOCS, resolveAgentRequiredDocuments } from '@/lib/admission-required-documents'

// قواعد مرفقات الوكالة والاعتماد: قائمة مشتركة للنوعين، تُضبط من تبويب
// قواعد القبول (نطاق الوكالة والاعتماد) وتُحفظ كـ JSON في إعداد
// AGENT_ADMISSION_RULES — تفعيل وثيقة يجعلها إجبارية عند التقديم.
export type AgentRulesBody = {
  requiredDocuments: string[]
  customDocuments: { type: string; label: string }[]
}

function sanitize(body: any): AgentRulesBody {
  const requiredDocuments = Array.isArray(body?.requiredDocuments)
    ? body.requiredDocuments.filter((d: any) => typeof d === 'string' && d.trim()).map((d: string) => d.trim().slice(0, 40)).slice(0, 10)
    : []
  const customDocuments = Array.isArray(body?.customDocuments)
    ? body.customDocuments
        .filter((d: any) => d && typeof d.type === 'string' && typeof d.label === 'string' && d.type.trim() && d.label.trim())
        .map((d: any) => ({ type: d.type.trim().slice(0, 40), label: d.label.trim().slice(0, 120) }))
        .slice(0, 10)
    : []
  return { requiredDocuments, customDocuments }
}

export async function GET() {
  try {
    await requireAdmin()
    const raw = await getSettingJson<any>('AGENT_ADMISSION_RULES', null)
    const resolved = resolveAgentRequiredDocuments(raw)
    const saved = raw && typeof raw === 'object' ? sanitize(raw) : { requiredDocuments: [], customDocuments: [] }
    return NextResponse.json({ rules: saved, docs: resolved.requiredDocs, customDocs: resolved.customDocs })
  } catch {
    return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const clean = sanitize(body)
    await db.setting.upsert({
      where: { key: 'AGENT_ADMISSION_RULES' },
      update: { value: JSON.stringify(clean) },
      create: { key: 'AGENT_ADMISSION_RULES', value: JSON.stringify(clean) },
    })
    const resolved = resolveAgentRequiredDocuments(clean)
    return NextResponse.json({ ok: true, rules: clean, docs: resolved.requiredDocs })
  } catch {
    return NextResponse.json({ error: 'تعذر حفظ قواعد الوكالة والاعتماد' }, { status: 500 })
  }
}
