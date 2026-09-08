import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// GET /api/directory — الدليل العام للمعتمدين والوكلاء (على الموقع الرسمي)
// يعرض المعتمدين (شهادات الاعتماد) والوكلاء المعتمدين مع إمكانية التحقق من شهاداتهم
export async function GET() {
  try {
    const certs = await db.certificate.findMany({
      where: { valid: true, type: { in: ['ACCREDITATION', 'AGENCY'] } },
      orderBy: { issuedAt: 'desc' },
      take: 100,
      include: {
        agent: {
          select: { kind: true, accreditationType: true, territory: true, exclusive: true, country: true, repName: true },
        },
      },
    })
    const agents = await db.agentApplication.findMany({
      where: { kind: 'AGENCY', status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, orgName: true, repName: true, country: true, territory: true,
        exclusive: true, contractNo: true, startDate: true, endDate: true,
      },
    })
    const agentIdsWithCerts = new Set(certs.filter((c) => c.agentId).map((c) => c.agentId))
    return NextResponse.json({
      accredited: certs.map((c) => ({
        serial: c.serial,
        holderName: c.holderName,
        program: c.program,
        type: c.type,
        country: c.country,
        issuedAt: c.issuedAt,
        accreditationType: c.agent?.accreditationType || null,
        repName: c.agent?.repName || null,
      })),
      agents: agents.map((a) => ({
        id: a.id,
        orgName: a.orgName,
        repName: a.repName,
        country: a.country,
        territory: a.territory || a.country,
        exclusive: a.exclusive,
        contractNo: a.contractNo,
        endDate: a.endDate,
        inDirectory: !agentIdsWithCerts.has(a.id),
      })),
    })
  } catch (e) {
    console.error('directory GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الدليل' }, { status: 500 })
  }
}
