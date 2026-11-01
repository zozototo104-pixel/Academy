// Fixture helper: renders one official PDF (the designed template used for
// certificates, transcripts and invoices) and writes it as a PDF file.
// Run with:
//   bun tests/pdf/render-official-fixture.ts <out.pdf>
// or under tsx (Node runtime) for the ensureStampFonts() code path.
// Fontconfig is controlled ENTIRELY by the parent process environment:
// setting FONTCONFIG_FILE inside a bun process does not reach fontconfig,
// so the caller must pass it via spawn env (or leave it unset and let
// renderOfficialPdf's ensureStampFonts() point at the bundled fonts, which
// works under Node). The content is deliberately Arabic-heavy: it is the
// text users saw turn into tofu boxes on production downloads.
import { writeFileSync } from 'fs'

async function main() {
  const outPath = process.argv[2]
  if (!outPath) {
    console.error('usage: render-official-fixture.ts <out.pdf>')
    process.exit(2)
  }

  const { renderOfficialPdf } = await import('@/lib/pdf/official')

  const pdf = await renderOfficialPdf({
    title: 'شهادة إتمام برنامج تدريبي',
    subtitle: 'تشهد الأكاديمية بأن الطالب أتم متطلبات البرنامج بنجاح',
    documentLabel: 'AACT-CERTIFICATE',
    status: 'الدرجة النهائية: امتياز مع مرتبة الشرف',
    statusTone: 'success',
    reference: 'AACT-C-2026-00004',
    sections: [
      {
        title: 'بيانات الخريج',
        rows: [
          { label: 'الاسم الكامل', value: 'أحمد محمد علي حسن' },
          { label: 'البرنامج', value: 'دبلوم إدارة الأزمات والكوارث' },
          { label: 'التقدير العام', value: 'امتياز' },
          { label: 'تاريخ الإصدار', value: '30 يونيو 2024' },
        ],
      },
      {
        title: 'ملخص أكاديمي',
        lines: ['تظهر هذه الوثيقة الرسمية نتيجة الطالب في البرنامج التدريبي المسجل لدى الأكاديمية، وتشمل جميع الوحدات الدراسية والدرجات النهائية المعتمدة.'],
      },
    ],
    tables: [
      {
        title: 'الوحدات الدراسية',
        columns: ['الوحدة', 'الحالة', 'الدرجة'],
        rows: [
          ['مدخل إلى إدارة الأزمات', 'مكتملة', 'امتياز'],
          ['التخطيط للطوارئ والاستجابة', 'مكتملة', 'امتياز'],
          ['إدارة فرق العمل تحت الضغط', 'مكتملة', 'جيد جدا'],
        ],
      },
    ],
  })
  writeFileSync(outPath, pdf)
  console.log(`rendered official pdf: ${pdf.length} bytes -> ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
