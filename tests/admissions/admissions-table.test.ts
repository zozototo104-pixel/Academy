import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const adminView = readFileSync('src/components/aact/AdminView.tsx', 'utf8')
const count = (needle: string) => adminView.split(needle).length - 1

// حراس تنظيم عرض قائمة الالتحاق الدراسي: جدول خفيف + تفصيل عند الضغط.
// التعديل عرض فقط — هذه الاختبارات تحرس أن سطح البيانات والأفعال والبحث والفلتر لم يتغيّر.
describe('admissions list table (presentation-only reorganization)', () => {
  test('renders a real table with the eight light columns for study admissions', () => {
    expect(adminView).toContain('<table')
    for (const header of ['الاسم', 'المرجع', 'البرنامج', 'الحالة', 'البلد', 'تاريخ التقديم', 'مستندات ناقصة', 'التواصل']) {
      expect(adminView).toContain(`>${header}</th>`)
    }
    // الصفوف تأتي من نفس مصدر اليوم وبنفس الترتيب.
    expect(adminView).toContain('pagedAdmissionRows.map((a) => {')
    expect(adminView).toContain("new Date(a.createdAt).toLocaleDateString('ar-EG')")
    expect(adminView).toContain('STATUS_BADGE[a.status]')
    expect(adminView).toContain('STATUS_LABEL[a.status]')
  })

  test('clicking the student name opens the detail; back returns to the table', () => {
    expect(adminView).toContain('const [selectedAdmissionId, setSelectedAdmissionId] = useState<string | null>(null)')
    expect(adminView).toContain('onClick={() => setSelectedAdmissionId(a.id)}')
    expect(adminView).toContain('عودة إلى القائمة')
    expect(adminView).toContain('onClick={() => setSelectedAdmissionId(null)}')
    // التفصيل يُبنى فقط من طلب كامل موجود ضمن المحمّل حاليًا.
    expect(adminView).toContain('admissions.find((x) => x.id === selectedAdmissionId)')
    expect(adminView).toContain('{renderAdmissionCard(selectedAdmission)}')
  })

  test('service-requests branch renders cards only — no table there, anchor intact', () => {
    const servicesStart = adminView.indexOf("activeTab === 'service-requests' ? (")
    const detailStart = adminView.indexOf(') : selectedAdmission ? (', servicesStart)
    expect(servicesStart).toBeGreaterThan(-1)
    expect(detailStart).toBeGreaterThan(servicesStart)
    const servicesBranch = adminView.slice(servicesStart, detailStart)
    expect(servicesBranch).toContain('pagedAdmissionRows.map((a) => renderAdmissionCard(a))')
    expect(servicesBranch).not.toContain('<table')
    // مرساة البطاقة كما هي — روابط التمييز والتمرير تعتمد عليها.
    expect(adminView).toContain('id={`admission-${a.id}`}')
  })

  test('the application card was moved, not rewritten: core actions and endpoints intact', () => {
    expect(adminView).toContain('const renderAdmissionCard = (a: AdmissionApp) => {')
    expect(count('setAdmissionStatus')).toBe(10)
    expect(count('editAdmissionEnglishName')).toBe(2)
    expect(count('setReplacementFormOpen')).toBe(4)
    expect(adminView).toContain('تعديل اسم الشهادة الإنجليزي')
    expect(adminView).toContain('إصدار الشهادة الدراسية')
    expect(adminView).toContain('/api/admissions/docs/')
    // نفس نداءات الـAPI بالضبط: جلب القائمة + تعديلات البطاقة.
    expect(count('/api/admin/admissions')).toBe(8)
    expect(adminView).toContain('`/api/admin/admissions?${params.toString()}`')
  })

  test('search, filter and pager surface is untouched', () => {
    expect(count('admissionSearch')).toBe(6)
    expect(count('admissionStatusFilter')).toBe(5)
    expect(count('AdminPager')).toBe(5)
    expect(adminView).toContain('ابحث في طلبات الالتحاق بالاسم أو الكود أو البرنامج...')
    expect(adminView).toContain('<AdminPager page={currentAdmissionPage} pageSize={admissionPageSize} total={admissionTotal}')
  })

  test('deep link opens the detail only for a fully loaded application', () => {
    expect(adminView).toContain('if (fullLinked) setSelectedAdmissionId(fullLinked.id)')
    // المرجع الجزئي وحده لا يفتح بطاقة ناقصة أبدًا.
    expect(adminView).not.toContain('setSelectedAdmissionId(linked.id)')
    expect(adminView).not.toContain('setSelectedAdmissionId(student.latestAdmission')
    expect(count('openStudentAdmission')).toBe(4)
  })

  test('highlight stays visible in table mode', () => {
    expect(adminView).toContain("highlightAdmissionId === a.id ? 'bg-[#f7edd0]/70' : ''")
    expect(adminView).toContain('scrollIntoView')
  })
})
