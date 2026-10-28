// Fixture helper: renders the legacy-certificate stamp text overlay and
// writes it as a PNG. Run with:
//   bun tests/legacy-graduates/render-stamp-overlay-fixture.ts <out.png>
// or under tsx (Node runtime) for the ensureStampFonts() code path.
// Fontconfig is controlled ENTIRELY by the parent process environment:
// setting FONTCONFIG_FILE inside a bun process does not reach fontconfig,
// so the caller must pass it via spawn env (or leave it unset and let
// ensureStampFonts() point at the bundled fonts, which works under Node).
// The render covers every field users saw turn into boxes: Arabic name,
// Arabic program, Arabic grade, date, and the serial.
import { writeFileSync } from 'fs'

async function main() {
  const outPath = process.argv[2]
  if (!outPath) {
    console.error('usage: render-stamp-overlay-fixture.ts <out.png>')
    process.exit(2)
  }

  const { normalizeStampLayout, renderCertificateStampTextOverlayPng } = await import(
    '@/lib/legacy-certificate-files'
  )

  const base = normalizeStampLayout('BOTTOM_LEFT', 'M')
  const layout = {
    ...base,
    holderName: { ...base.holderName, visible: true, lang: 'ar' as const, fontFamily: 'Noto Naskh Arabic' },
    program: { ...base.program, visible: true, lang: 'ar' as const, fontFamily: 'Noto Naskh Arabic' },
    grade: { ...base.grade, visible: true, lang: 'ar' as const, fontFamily: 'Noto Naskh Arabic' },
    issuedAt: { ...base.issuedAt, visible: true },
  }

  const overlay = await renderCertificateStampTextOverlayPng({
    width: 595,
    height: 842,
    layout,
    values: {
      holderName: 'أحمد محمد علي',
      holderNameEn: 'Ahmed Mohamed Ali',
      program: 'دبلوم إدارة الأزمات',
      programEn: 'Crisis Management Diploma',
      grade: 'امتياز',
      gradeEn: 'Excellent',
      issuedAt: new Date('2024-06-30'),
      serial: 'AACT-C-2026-00001',
    },
  })
  if (!overlay) {
    console.error('overlay render returned null')
    process.exit(1)
  }
  writeFileSync(outPath, overlay)
  console.log(`rendered overlay: ${overlay.length} bytes -> ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
