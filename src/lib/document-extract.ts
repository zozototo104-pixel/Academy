export interface ExtractedDocumentText {
  text: string
  readable: boolean
  reader: 'PDF' | 'DOCX' | 'XLSX' | 'TEXT' | 'CSV' | 'RTF' | 'UNSUPPORTED' | 'EMPTY' | 'ERROR'
  note: string
}

function stripPageAndReaderArtifacts(text: string): string {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    // PDF/Word readers sometimes inject counters like: 1 of 397 --- 2 of 397
    .replace(/\b\d{1,5}\s+of\s+\d{1,5}\b/gi, ' ')
    .replace(/(?:^|\s)of\s+\d{1,5}\b/gi, ' ')
    .replace(/\bpage\s+\d{1,5}\s+(?:of|\/|من)\s+\d{1,5}\b/gi, ' ')
    .replace(/\bصفحة\s+\d{1,5}\s+(?:من|\/|of)\s+\d{1,5}\b/gi, ' ')
    // remove long visual separators emitted by parsers
    .replace(/[ـ_\-–—]{3,}/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false
      if (/^(?:[\-–—_ـ\s]+|\d+|of\s+\d+)$/i.test(line)) return false
      const letters = (line.match(/[\p{L}]/gu) || []).length
      const digits = (line.match(/\d/g) || []).length
      return !(digits >= 4 && letters <= 2)
    })
    .join('\n')
}

export function normalizeExtractedText(text: string, maxChars: number): string {
  return stripPageAndReaderArtifacts(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars)
}

function extOf(fileName?: string | null): string {
  const m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m?.[1] || ''
}

export function isPdfLike(mimeType: string, fileName?: string | null): boolean {
  return mimeType.includes('pdf') || extOf(fileName) === 'pdf'
}

export function isDocxLike(mimeType: string, fileName?: string | null): boolean {
  const ext = extOf(fileName)
  return mimeType.includes('wordprocessingml') || ext === 'docx'
}

export function isExcelLike(mimeType: string, fileName?: string | null): boolean {
  const ext = extOf(fileName)
  return mimeType.includes('spreadsheetml') || mimeType.includes('excel') || ['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)
}

export function isTextLike(mimeType: string, fileName?: string | null): boolean {
  const ext = extOf(fileName)
  return mimeType.startsWith('text/') || ['txt', 'csv', 'md', 'rtf'].includes(ext)
}

async function extractPdf(buffer: Buffer, maxChars: number): Promise<ExtractedDocumentText> {
  try {
    // مهم في Vercel/Next: تهيئة worker/canvas قبل تحميل pdf-parse حتى لا يظهر DOMMatrix is not defined.
    const worker = await import('pdf-parse/worker')
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({
      data: new Uint8Array(buffer),
      CanvasFactory: (worker as any).CanvasFactory,
    } as any)

    try {
      const result = await parser.getText()
      const text = normalizeExtractedText(result?.text || '', maxChars)
      return {
        text,
        readable: text.length >= 40,
        reader: text.length >= 40 ? 'PDF' : 'EMPTY',
        note: text.length >= 40 ? 'تم استخراج نص PDF بنجاح' : 'PDF لا يحتوي نصاً كافياً؛ سيتم تمريره للرؤية الذكية إن أمكن',
      }
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch (e: any) {
    return { text: '', readable: false, reader: 'ERROR', note: `تعذر قراءة PDF نصياً: ${String(e?.message || e).slice(0, 180)}` }
  }
}

async function extractDocx(buffer: Buffer, maxChars: number): Promise<ExtractedDocumentText> {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    const text = normalizeExtractedText(result?.value || '', maxChars)
    return {
      text,
      readable: text.length >= 30,
      reader: text.length >= 30 ? 'DOCX' : 'EMPTY',
      note: text.length >= 30 ? 'تم استخراج نص Word DOCX بنجاح' : 'ملف Word لا يحتوي نصاً كافياً أو هو صورة داخل ملف',
    }
  } catch (e: any) {
    return { text: '', readable: false, reader: 'ERROR', note: `تعذر قراءة Word DOCX: ${String(e?.message || e).slice(0, 180)}` }
  }
}

async function extractExcel(buffer: Buffer, fileName: string | null | undefined, maxChars: number): Promise<ExtractedDocumentText> {
  try {
    if (extOf(fileName) === 'csv') {
      const text = normalizeExtractedText(buffer.toString('utf8'), maxChars)
      return { text, readable: text.length >= 20, reader: 'CSV', note: text.length >= 20 ? 'تم استخراج CSV بنجاح' : 'ملف CSV فارغ أو غير قابل للقراءة' }
    }
    const XLSX = await import('xlsx')
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const parts: string[] = []
    for (const name of wb.SheetNames.slice(0, 8)) {
      const sheet = wb.Sheets[name]
      const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ' | ' })
      if (csv.trim()) parts.push(`ورقة ${name}:\n${csv}`)
    }
    const text = normalizeExtractedText(parts.join('\n\n'), maxChars)
    return {
      text,
      readable: text.length >= 20,
      reader: text.length >= 20 ? 'XLSX' : 'EMPTY',
      note: text.length >= 20 ? 'تم استخراج جداول Excel بنجاح' : 'ملف Excel فارغ أو غير قابل للقراءة',
    }
  } catch (e: any) {
    return { text: '', readable: false, reader: 'ERROR', note: `تعذر قراءة Excel: ${String(e?.message || e).slice(0, 180)}` }
  }
}

function extractPlainText(buffer: Buffer, mimeType: string, fileName: string | null | undefined, maxChars: number): ExtractedDocumentText {
  const ext = extOf(fileName)
  let text = buffer.toString('utf8')
  let reader: ExtractedDocumentText['reader'] = ext === 'rtf' || mimeType.includes('rtf') ? 'RTF' : ext === 'csv' ? 'CSV' : 'TEXT'
  if (reader === 'RTF') {
    text = text
      .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
      .replace(/\\[a-z]+-?\d* ?/gi, ' ')
      .replace(/[{}]/g, ' ')
  }
  text = normalizeExtractedText(text, maxChars)
  return { text, readable: text.length >= 20, reader, note: text.length >= 20 ? 'تم استخراج النص بنجاح' : 'ملف نصي فارغ أو غير قابل للقراءة' }
}

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  fileName?: string | null,
  maxChars = 40000
): Promise<ExtractedDocumentText> {
  const mime = String(mimeType || '').toLowerCase()
  const ext = extOf(fileName)
  if (!buffer?.length) return { text: '', readable: false, reader: 'EMPTY', note: 'الملف فارغ' }
  if (isPdfLike(mime, fileName)) return extractPdf(buffer, maxChars)
  if (isDocxLike(mime, fileName)) return extractDocx(buffer, maxChars)
  if (isExcelLike(mime, fileName)) return extractExcel(buffer, fileName, maxChars)
  if (isTextLike(mime, fileName)) return extractPlainText(buffer, mime, fileName, maxChars)
  if (ext === 'doc') return { text: '', readable: false, reader: 'UNSUPPORTED', note: 'صيغة DOC القديمة غير مدعومة آلياً؛ يرجى رفع DOCX أو PDF نصي' }
  return { text: '', readable: false, reader: 'UNSUPPORTED', note: 'نوع الملف غير مدعوم للاستخراج النصي الآلي' }
}
