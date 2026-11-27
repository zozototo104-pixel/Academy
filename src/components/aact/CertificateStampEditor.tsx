'use client'

// Shared certificate stamp editor — the drag editor from the legacy
// graduates upload, used by all three certificate upload places
// (legacy graduates, regular graduates, comprehensive-exam candidates).
// The admin drags the QR code and the serial number anywhere on the
// live preview and resizes with the gold handle; the layout (free x/y
// percentages) is what the upload routes stamp onto the file.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
// The stamping implementation is server-only (pdf-lib, sharp, fs, storage).
// Keep this UI's layout conversion pure so it cannot pull Node modules into
// Next.js client bundles. The upload routes normalize the layout again.
import type { LegacyStampLayout, StampTextField } from '@/lib/legacy-certificate-files'

export type CertificateStampField = 'holderName' | 'program' | 'grade' | 'issuedAt' | 'serial' | 'legacySerial' | 'qr'
export type CertificateStampTextField = StampTextField
export type CertificateStampLayout = LegacyStampLayout

export const CERTIFICATE_STAMP_LABELS: Record<CertificateStampField, string> = { holderName: 'اسم الطالب', program: 'البرنامج', grade: 'التقدير', issuedAt: 'تاريخ الإصدار', serial: 'الرقم التسلسلي', legacySerial: 'الرقم القديم', qr: 'رمز QR' }
export const CERTIFICATE_STAMP_TEXT_FIELDS: CertificateStampField[] = ['holderName', 'program', 'grade', 'issuedAt', 'serial', 'legacySerial']
export const CERTIFICATE_STAMP_FIELDS: CertificateStampField[] = ['holderName', 'program', 'grade', 'issuedAt', 'serial', 'legacySerial', 'qr']

// The legacy default: name/program/grade/date hidden (a ready certificate
// already carries them printed), QR + serial visible at the bottom-left.
function stampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function fallbackStampLayout(positionValue?: string | null, sizeValue?: string | null): CertificateStampLayout {
  const position = String(positionValue || '').trim().toUpperCase()
  const size = String(sizeValue || '').trim().toUpperCase()
  const qrSize = size === 'L' ? 20 : size === 'S' ? 12 : 16
  const right = position === 'BOTTOM_RIGHT' || position === 'TOP_RIGHT'
  const top = position === 'TOP_LEFT' || position === 'TOP_RIGHT'
  const x = right ? 100 - (7 + qrSize / 2) : 7 + qrSize / 2
  const y = top ? 7 + qrSize / 2 : 100 - (10 + qrSize / 2)
  const serialY = top ? Math.min(96, y + qrSize / 2 + 4) : 95
  const text = (tx: number, ty: number, width = 70, fontSize = 2.2, extra: Partial<StampTextField> = {}): StampTextField => ({
    x: tx, y: ty, width, fontSize, color: '#0f2b46', align: 'center', fontFamily: 'Arial', lang: 'en', visible: true, ...extra,
  })
  return {
    holderName: text(50, 36, 72, 4.2, { visible: false }),
    program: text(50, 51, 76, 2.5, { color: '#a8841a', visible: false }),
    grade: text(50, 62, 44, 1.7, { visible: false }),
    issuedAt: text(18, 90, 26, 1.15, { align: 'left', visible: false }),
    serial: text(x, serialY, Math.max(20, qrSize * 1.8), size === 'L' ? 1.6 : size === 'S' ? 1.0 : 1.25),
    legacySerial: text(x, top ? Math.min(96, serialY + 4) : serialY - 3, Math.max(20, qrSize * 1.8), size === 'L' ? 1.6 : size === 'S' ? 1.0 : 1.25),
    qr: { x, y, size: qrSize, visible: true },
  }
}

function normalizeStampText(raw: unknown, fallback: StampTextField): StampTextField {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const value = raw as Partial<StampTextField>
  const lang = value.lang === 'ar' ? 'ar' : fallback.lang || 'en'
  return {
    x: stampNumber(value.x, 1, 99, fallback.x),
    y: stampNumber(value.y, 1, 99, fallback.y),
    width: stampNumber(value.width, 6, 95, fallback.width),
    fontSize: stampNumber(value.fontSize, 0.5, 8, fallback.fontSize),
    color: String(value.color || fallback.color || '#0f2b46'),
    align: value.align === 'left' || value.align === 'center' || value.align === 'right' ? value.align : fallback.align || 'center',
    fontFamily: String(value.fontFamily || fallback.fontFamily || (lang === 'ar' ? 'Noto Naskh Arabic' : 'Arial')),
    lang,
    visible: typeof value.visible === 'boolean' ? value.visible : fallback.visible,
  }
}

function normalizeClientStampLayout(value: unknown, sizeValue: unknown = 'M'): CertificateStampLayout {
  let raw: unknown = value
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { raw = JSON.parse(value) } catch { raw = null }
  }
  const fallback = fallbackStampLayout(typeof value === 'string' ? value : 'BOTTOM_LEFT', String(sizeValue || 'M'))
  if (!raw || typeof raw !== 'object') return fallback
  const fields = raw as Partial<CertificateStampLayout>
  const qr = fields.qr
  return {
    holderName: normalizeStampText(fields.holderName, fallback.holderName),
    program: normalizeStampText(fields.program, fallback.program),
    grade: normalizeStampText(fields.grade, fallback.grade),
    issuedAt: normalizeStampText(fields.issuedAt, fallback.issuedAt),
    serial: normalizeStampText(fields.serial, fallback.serial),
    legacySerial: normalizeStampText(fields.legacySerial, fallback.legacySerial),
    qr: qr && typeof qr === 'object' ? {
      x: stampNumber(qr.x, 1, 99, fallback.qr.x),
      y: stampNumber(qr.y, 1, 99, fallback.qr.y),
      size: stampNumber(qr.size, 4, 45, fallback.qr.size),
      visible: typeof qr.visible === 'boolean' ? qr.visible : fallback.qr.visible,
    } : { ...fallback.qr },
  }
}

export const DEFAULT_CERTIFICATE_STAMP_LAYOUT: CertificateStampLayout = normalizeClientStampLayout('BOTTOM_LEFT', 'M')

// Saved layouts are stored as JSON in Certificate.qrPosition; older
// records still carry a corner name (BOTTOM_LEFT …) — both parse to a
// full layout, exactly like the legacy upload modal does.
export function parseCertificateStampLayout(positionValue?: string | null, sizeValue?: string | null): CertificateStampLayout {
  return normalizeClientStampLayout(positionValue ?? 'BOTTOM_LEFT', sizeValue ?? 'M')
}

export function serializeCertificateStampLayout(layout: CertificateStampLayout): string {
  return JSON.stringify(normalizeClientStampLayout(layout))
}

const DEFAULT_HINT = 'اسحب أي عنصر لتحريكه، واسحب المقبض الذهبي الصغير لتكبيره أو تصغيره. الافتراضي يخفي الاسم والبرنامج والتقدير والتاريخ للشهادات الجاهزة.'

type CertificateStampEditorProps = {
  layout: CertificateStampLayout
  onLayoutChange: (layout: CertificateStampLayout) => void
  // Which fields the admin may move in this place. Legacy: all seven;
  // ready-certificate uploads (regular / comprehensive): QR + serial only.
  fields: CertificateStampField[]
  // The text shown on each draggable chip (serial number, holder name …).
  fieldTexts: Partial<Record<CertificateStampField, string>>
  // Backdrop image of the certificate itself (a newly picked image file,
  // or the stored original when the place serves one). Null shows the
  // placeholder text instead — PDFs have no image backdrop.
  backdropUrl: string | null
  backdropEmptyText: string
  selectedField: CertificateStampField
  onSelectedFieldChange: (field: CertificateStampField) => void
  // Optional note rendered at the top of the side panel (the legacy
  // "original is not redrawn" box lives here).
  info?: ReactNode
  hint?: string
}

export default function CertificateStampEditor({
  layout,
  onLayoutChange,
  fields,
  fieldTexts,
  backdropUrl,
  backdropEmptyText,
  selectedField,
  onSelectedFieldChange,
  info,
  hint = DEFAULT_HINT,
}: CertificateStampEditorProps) {
  const stampCanvasRef = useRef<HTMLDivElement | null>(null)
  const stampDragRef = useRef<CertificateStampField | null>(null)
  const stampResizeRef = useRef<{ field: CertificateStampField; startX: number; startY: number; startSize: number; startWidth: number; startFontSize: number } | null>(null)

  function moveStampField(field: CertificateStampField, clientX: number, clientY: number) {
    const rect = stampCanvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(1, Math.min(99, ((clientX - rect.left) / rect.width) * 100))
    const y = Math.max(1, Math.min(99, ((clientY - rect.top) / rect.height) * 100))
    onLayoutChange({ ...layout, [field]: { ...layout[field], x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) } })
  }

  function resizeStampField(clientX: number, clientY: number) {
    const active = stampResizeRef.current
    const rect = stampCanvasRef.current?.getBoundingClientRect()
    if (!active || !rect) return
    const delta = (((clientX - active.startX) / rect.width) + ((clientY - active.startY) / rect.height)) * 50
    if (active.field === 'qr') {
      const size = Math.max(4, Math.min(45, active.startSize + delta))
      onLayoutChange({ ...layout, qr: { ...layout.qr, size: Number(size.toFixed(1)) } })
      return
    }
    const width = Math.max(6, Math.min(95, active.startWidth + delta))
    const fontSize = Math.max(0.5, Math.min(8, active.startFontSize + delta * 0.08))
    onLayoutChange({ ...layout, [active.field]: { ...(layout[active.field] as StampTextField), width: Number(width.toFixed(1)), fontSize: Number(fontSize.toFixed(1)) } })
  }

  function stampFieldStyle(field: CertificateStampField) {
    const cfg = layout[field]
    const isQr = field === 'qr'
    const textCfg = isQr ? null : cfg as StampTextField
    return {
      position: 'absolute' as const,
      left: `${cfg.x}%`,
      top: `${cfg.y}%`,
      width: isQr ? `${layout.qr.size}%` : `${textCfg?.width ?? 30}%`,
      aspectRatio: isQr ? '1 / 1' : undefined,
      minHeight: isQr ? undefined : '22px',
      transform: 'translate(-50%, -50%)',
      textAlign: (textCfg?.align || 'center') as any,
      direction: isQr ? undefined : (textCfg?.lang === 'ar' ? 'rtl' as const : 'ltr' as const),
      fontFamily: isQr ? undefined : (textCfg?.fontFamily || 'Arial'),
      fontSize: isQr ? undefined : `clamp(10px, ${textCfg?.fontSize ?? 1.2}vw, 42px)`,
      fontWeight: 900,
      lineHeight: 1.2,
      cursor: 'move',
      touchAction: 'none' as const,
      overflow: 'visible' as const,
      border: selectedField === field ? '2px solid #c9a227' : '1px dashed rgba(15,43,70,.35)',
      background: isQr ? 'white' : 'rgba(255,255,255,.78)',
      borderRadius: '10px',
      padding: isQr ? '4px' : '4px 8px',
      color: textCfg?.color || '#0f2b46',
    }
  }

  const visibleFields = fields.filter((field) => layout[field]?.visible !== false)
  const effectiveSelectedField = fields.includes(selectedField) ? selectedField : fields[0]

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="space-y-3">
        {info}
        <div className="space-y-1.5">
          <Label className="text-[11px] font-black text-slate-600">العنصر المحدد</Label>
          <Select value={effectiveSelectedField} onValueChange={(v) => onSelectedFieldChange(v as CertificateStampField)}>
            <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fields.map((field) => <SelectItem key={field} value={field}>{CERTIFICATE_STAMP_LABELS[field]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" className="w-full bg-white text-xs font-black" onClick={() => onLayoutChange({ ...layout, [effectiveSelectedField]: { ...layout[effectiveSelectedField], visible: layout[effectiveSelectedField]?.visible === false } })}>
          {layout[effectiveSelectedField]?.visible === false ? 'إظهار العنصر' : 'إخفاء العنصر'}
        </Button>
        {CERTIFICATE_STAMP_TEXT_FIELDS.includes(effectiveSelectedField) && (
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-white p-3">
            <div className="space-y-1"><Label className="text-[10px] font-bold">حجم الخط</Label><Input type="number" step="0.1" min="0.5" max="8" value={(layout[effectiveSelectedField] as StampTextField).fontSize ?? 1.2} onChange={(e) => onLayoutChange({ ...layout, [effectiveSelectedField]: { ...(layout[effectiveSelectedField] as StampTextField), fontSize: Number(e.target.value || 1.2) } })} /></div>
            <div className="space-y-1"><Label className="text-[10px] font-bold">العرض %</Label><Input type="number" min="6" max="95" value={(layout[effectiveSelectedField] as StampTextField).width ?? 30} onChange={(e) => onLayoutChange({ ...layout, [effectiveSelectedField]: { ...(layout[effectiveSelectedField] as StampTextField), width: Number(e.target.value || 30) } })} /></div>
          </div>
        )}
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-900">
          {hint}
        </div>
      </div>
      <div
        ref={stampCanvasRef}
        className={`relative overflow-hidden rounded-2xl border border-[#0f2b46]/10 bg-white shadow-inner ${backdropUrl ? '' : 'aspect-[1.414/1]'}`}
        onPointerMove={(e) => {
          if (stampResizeRef.current) {
            resizeStampField(e.clientX, e.clientY)
            return
          }
          if (e.buttons !== 1) return
          moveStampField(stampDragRef.current || effectiveSelectedField, e.clientX, e.clientY)
        }}
        onPointerDown={(e) => {
          stampDragRef.current = effectiveSelectedField
          moveStampField(effectiveSelectedField, e.clientX, e.clientY)
        }}
        onPointerUp={() => { stampDragRef.current = null; stampResizeRef.current = null }}
        onPointerLeave={() => { stampDragRef.current = null; stampResizeRef.current = null }}
      >
        {backdropUrl ? (
          <img src={backdropUrl} alt="معاينة الشهادة المرفوعة" className="block h-auto w-full select-none" draggable={false} />
        ) : (
          <div className="flex h-full min-h-[260px] items-center justify-center bg-slate-50 p-6 text-center text-xs font-bold leading-6 text-slate-500">
            {backdropEmptyText}
          </div>
        )}
        {visibleFields.map((field) => (
          <button
            key={field}
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation()
              stampDragRef.current = field
              onSelectedFieldChange(field)
              moveStampField(field, e.clientX, e.clientY)
            }}
            style={stampFieldStyle(field)}
            className="select-none touch-none"
          >
            {fieldTexts[field] ?? CERTIFICATE_STAMP_LABELS[field]}
            <span
              aria-hidden="true"
              className="absolute -bottom-2 -left-2 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-white bg-[#c9a227] shadow"
              onPointerDown={(e) => {
                e.stopPropagation()
                onSelectedFieldChange(field)
                stampResizeRef.current = {
                  field,
                  startX: e.clientX,
                  startY: e.clientY,
                  startSize: layout.qr.size,
                  startWidth: field === 'qr' ? layout.serial.width : (layout[field] as StampTextField).width,
                  startFontSize: field === 'qr' ? layout.serial.fontSize : (layout[field] as StampTextField).fontSize,
                }
              }}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
