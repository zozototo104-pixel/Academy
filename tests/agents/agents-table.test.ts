import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// حارس تنظيم تبويب «الوكالة والاعتماد» (نمط A): جدول خفيف + بطاقة الطلب نفسها كعرض تفصيلي.
// يثبّت أن التحويل شكلي فقط: البطاقة منقولة حرفيًا بكل أفعالها، والبحث والفلتر والجلب والمصفّح
// مجمّدة، وصفوف الجدول بلا أي أفعال (القبول/الرفض/الإلغاء/المعاينة داخل التفصيل فقط)،
// وقاعدة خلية الوثائق والرسوم: «—» للاعتماد فقط عند اكتمال الوثائق وعدم وجود رسوم غير مسددة.

const adminViewPath = path.join(import.meta.dir, '../../src/components/aact/AdminView.tsx')
const adminView = readFileSync(adminViewPath, 'utf8')

const count = (needle: string) => adminView.split(needle).length - 1

const agentsStart = adminView.indexOf('TabsContent value="agents"')
const agentsEnd = adminView.indexOf('TabsContent value="representatives"')
const agentsSection = adminView.slice(agentsStart, agentsEnd)
const tableStart = agentsSection.indexOf('<table')
const tableEnd = agentsSection.indexOf('</table>')
const tableSlice = agentsSection.slice(tableStart, tableEnd)

describe('agents tab — Pattern A table + detail (presentation only)', () => {
  test('the full application card moved verbatim into an in-file render function', () => {
    expect(adminView).toContain('const renderAgentCard = (a: AgentApp) => {')
    const fnStart = adminView.indexOf('const renderAgentCard')
    const cardBody = adminView.slice(fnStart, fnStart + 12000)
    // كل أفعال البطاقة وأقسامها داخل الدالة المنقولة كما كانت في القائمة.
    expect(cardBody).toContain("setAppStatus(a.id, 'APPROVED')")
    expect(cardBody).toContain("setAppStatus(a.id, 'REJECTED')")
    expect(cardBody).toContain('onClick={() => revokeApp(a)}')
    expect(count('openAgentPreview(a.id)')).toBe(3)
    expect(cardBody).toContain('/api/agent-docs/')
    expect(cardBody).toContain('الوثائق الرسمية المرفوعة')
    expect(cardBody).toContain('تم سحب الاعتماد/الوكالة')
    // الاستدعاء في العرض التفصيلي فقط.
    expect(adminView).toContain('{renderAgentCard(selectedApp)}')
  })

  test('the list renders a light 8-column table in the agents tab', () => {
    expect(agentsStart).toBeGreaterThan(-1)
    expect(tableStart).toBeGreaterThan(-1)
    for (const header of ['الجهة', 'النوع', 'الممثل', 'البلد', 'الحالة', 'تاريخ التقديم', 'الوثائق والرسوم', 'التواصل']) {
      expect(tableSlice).toContain(`<th className="px-3 py-2.5 font-black">${header}</th>`)
    }
    expect(tableSlice).toContain('pagedApps.map')
    expect(tableSlice).toContain('{a.orgName}')
    expect(tableSlice).toContain('{a.repName}')
    expect(tableSlice).toContain('{a.country}')
    expect(tableSlice).toContain("new Date(a.createdAt).toLocaleDateString('ar-EG')")
    expect(tableSlice).toContain('ACC_TYPE_LABEL[a.accreditationType')
  })

  test('table rows carry no action handlers — actions live in the detail only', () => {
    expect(tableSlice).not.toContain('setAppStatus')
    expect(tableSlice).not.toContain('revokeApp')
    expect(tableSlice).not.toContain('openAgentPreview')
    expect(tableSlice).toContain('onClick={() => setSelectedAppId(a.id)}')
  })

  test('staff-submitted marker and contract number survive in table mode', () => {
    expect(tableSlice).toContain('طلب داخلي')
    expect(tableSlice).toContain("!!a.submittedByStaff || (!!a.user && ['ADMIN', 'SUPERVISOR'].includes(a.user.role))")
    expect(tableSlice).toContain('{a.contractNo}')
  })

  test('documents/fees cell: dash only when complete, otherwise the specific gap', () => {
    // «—» للاعتماد فقط عند وثائق 4/4 ولا رسوم غير مسددة؛ ولغير الاعتماد دائمًا.
    expect(tableSlice).toContain("(a.documents?.length || 0) >= 4 && (!a.applicationFee || a.applicationFee.status === 'PAID')")
    expect(tableSlice).toContain("a.kind !== 'ACCREDITATION'")
    // النقص يظهر بعينه.
    expect(tableSlice).toContain('وثائق {a.documents?.length || 0}/4')
    expect(tableSlice).toContain('رسوم غير مسددة')
    expect(tableSlice).toContain("a.applicationFee.status !== 'PAID'")
  })

  test('selection is a total assignment and the detail derives from the loaded page', () => {
    expect(adminView).toContain('const [selectedAppId, setSelectedAppId] = useState<string | null>(null)')
    expect(adminView).toContain('pagedApps.find((x) => x.id === selectedAppId)')
    expect(adminView).toContain('onClick={() => setSelectedAppId(a.id)}')
    expect(adminView).toContain('onClick={() => setSelectedAppId(null)}')
    expect(agentsSection).toContain('عودة إلى القائمة')
  })

  test('frozen surfaces: toolbar, fetch, actions and pager counts are unchanged', () => {
    expect(count('setAppStatus')).toBe(4)
    expect(count('revokeApp')).toBe(2)
    expect(count('openAgentPreview')).toBe(4)
    expect(count('/api/admin/applications')).toBe(2)
    expect(count('/api/agent-docs/')).toBe(1)
    expect(count('agentSearch')).toBe(6)
    expect(count('agentStatusFilter')).toBe(5)
    expect(count('AdminPager')).toBe(5)
    // جدول واحد جديد فقط في الملف كله (الطلاب + المحاولات + الالتحاق + الوكالة).
    expect(count('<table')).toBe(4)
    // البحث التعريفي وحالات الفراغ كما هي.
    expect(agentsSection).toContain('ابحث باسم الجهة أو الممثل أو البلد أو العقد...')
    expect(agentsSection).toContain('لا توجد طلبات وكالة بعد')
    expect(agentsSection).toContain('لا توجد طلبات مطابقة للبحث أو الفلتر الحالي')
  })
})
