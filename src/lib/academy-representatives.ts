import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import QRCode from 'qrcode'

export type RepresentativePublicFile = {
  id: string
  kind: string
  title: string
  description?: string | null
  externalUrl?: string | null
  fileUrl?: string | null
}

export type RepresentativePublicProfile = {
  id: string
  slug: string
  status: string
  cardNumber?: string | null
  validFrom?: string | Date | null
  validUntil?: string | Date | null
  fullName: string
  displayTitle?: string | null
  degreeTitle?: string | null
  academicRank?: string | null
  country: string
  region: string
  territory?: string | null
  city?: string | null
  specialization?: string | null
  representativeRole?: string | null
  shortBio?: string | null
  professionalBio?: string | null
  worksSummary?: string | null
  achievements?: string | null
  publicContactNote?: string | null
  phone?: string | null
  email?: string | null
  whatsapp?: string | null
  website?: string | null
  profilePhotoUrl?: string | null
  officialCardUrl?: string | null
  qrToken?: string | null
  verifyUrl?: string | null
  qrDataUrl?: string | null
  featured?: boolean
  sortOrder?: number
  files?: RepresentativePublicFile[]
}

export const DEMO_REPRESENTATIVES: RepresentativePublicProfile[] = [
  {
    id: 'demo-egypt',
    slug: 'dr-samer-almasri-egypt',
    status: 'ACTIVE',
    fullName: 'د. سامر المصري',
    displayTitle: 'ممثل الأكاديمية في جمهورية مصر العربية',
    degreeTitle: 'دكتوراه مهنية في إدارة الأعمال',
    academicRank: 'أستاذ مشارك',
    country: 'مصر',
    region: 'شمال أفريقيا',
    territory: 'القاهرة الكبرى والدلتا',
    city: 'القاهرة',
    specialization: 'إدارة التدريب وبناء القدرات المؤسسية',
    representativeRole: 'COUNTRY_REPRESENTATIVE',
    shortBio: 'خبير تدريب إداري وتطوير مؤسسي يعمل على ربط الأكاديمية بمراكز التدريب والجهات المهنية داخل مصر.',
    professionalBio: 'يمثل الأكاديمية الأمريكية للاستشارات والتدريب في نطاقه الجغرافي، ويعمل على التعريف بالبرامج المهنية، بناء الشراكات التدريبية، وتسهيل التواصل الأكاديمي مع المؤسسات الراغبة في التعاون وفق سياسات الأكاديمية.',
    worksSummary: 'إدارة برامج تدريبية للقيادات الوسطى، تطوير حقائب تدريبية، وتنظيم ورش عمل في الجودة والإدارة.',
    achievements: 'ساهم في تنفيذ مبادرات تدريبية لفرق إدارية وتعليمية، وشارك في لجان تطوير مناهج مهنية قصيرة.',
    publicContactNote: 'هذه بيانات وهمية للعرض التجريبي، ويمكن للإدارة تعديلها من لوحة الإدارة.',
    phone: '+20 100 000 0000',
    email: 'egypt.rep@example.com',
    whatsapp: '+20 100 000 0000',
    website: 'https://example.com',
    profilePhotoUrl: '',
    officialCardUrl: '',
    featured: true,
    sortOrder: 1,
    files: [
      { id: 'demo-egypt-file-1', kind: 'LINK', title: 'نموذج أعمال تدريبية', description: 'رابط تجريبي يعرض نوعية الأعمال التي يمكن إضافتها للممثل.', externalUrl: 'https://example.com' },
    ],
  },
  {
    id: 'demo-gulf',
    slug: 'prof-laila-haddad-gulf',
    status: 'ACTIVE',
    fullName: 'البروفيسور ليلى حداد',
    displayTitle: 'ممثلة الأكاديمية في الخليج العربي',
    degreeTitle: 'بروفيسور في القيادة المؤسسية',
    academicRank: 'بروفيسور',
    country: 'دول الخليج',
    region: 'الخليج العربي',
    territory: 'السعودية، الإمارات، قطر، الكويت، البحرين، عُمان',
    city: 'الرياض / دبي',
    specialization: 'القيادة، الحوكمة، الجودة والتميز المؤسسي',
    representativeRole: 'REGIONAL_REPRESENTATIVE',
    shortBio: 'أكاديمية ومستشارة تطوير مؤسسي تمثل الأكاديمية في بناء العلاقات المهنية والشراكات النوعية في الخليج.',
    professionalBio: 'تعمل على تمثيل الأكاديمية في الفعاليات المهنية، استقبال طلبات التعاون المؤسسي، وتعزيز حضور البرامج المهنية المعتمدة ضمن إطار التمثيل الرسمي المحدد من الإدارة.',
    worksSummary: 'استشارات قيادة وتحول مؤسسي، تصميم برامج قيادية، ومراجعة أطر جودة تدريبية.',
    achievements: 'قادَت مبادرات استشارية في التميز المؤسسي وشاركت في مؤتمرات تدريب وقيادة إقليمية.',
    publicContactNote: 'هذه بيانات وهمية للعرض التجريبي حتى إدخال البيانات الرسمية من لوحة الإدارة.',
    phone: '+971 50 000 0000',
    email: 'gulf.rep@example.com',
    whatsapp: '+971 50 000 0000',
    profilePhotoUrl: '',
    officialCardUrl: '',
    featured: true,
    sortOrder: 2,
    files: [],
  },
]

export function normalizeRepresentativeSlug(value: string, fallback = 'representative') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return slug || fallback
}

export function representativeLookupCandidates(value: string) {
  const raw = String(value || '').trim()
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const normalized = normalizeRepresentativeSlug(decoded, '')
  return Array.from(new Set([raw, decoded, normalized].filter(Boolean)))
}

export function createRepresentativeQrToken() {
  return `rep_${randomBytes(24).toString('base64url')}`
}

export function createRepresentativeOnboardingToken() {
  return `rep_onb_${randomBytes(32).toString('base64url')}`
}

function verificationSecret() {
  return process.env.AACT_REPRESENTATIVE_CARD_SECRET || process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET || 'aact-representative-local-secret'
}

export function normalizeArabicIndicDigits(value?: string | null) {
  return String(value || '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
}

export function normalizeLast4(value?: string | null) {
  const raw = normalizeArabicIndicDigits(value).trim()
  return /^\d{4}$/.test(raw) ? raw : ''
}

export function normalizePhoneLast4(value?: string | null) {
  const digits = normalizeArabicIndicDigits(value).replace(/\D+/g, '')
  return digits.length >= 4 ? digits.slice(-4) : ''
}

export function hashRepresentativeVerifier(value?: string | null) {
  const last4 = normalizePhoneLast4(value)
  if (!/^\d{4}$/.test(last4)) return null
  return createHash('sha256').update(`${verificationSecret()}:${last4}`).digest('hex')
}

export function verifyRepresentativeLast4(input: string, phoneHash?: string | null) {
  const last4 = normalizeLast4(input)
  if (!last4 || !phoneHash) return false
  const candidate = createHash('sha256').update(`${verificationSecret()}:${last4}`).digest('hex')
  try {
    const a = Buffer.from(candidate, 'hex')
    const b = Buffer.from(phoneHash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function representativeVerifyUrl(token: string, _origin?: string | null) {
  const base = String(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return `${base}/representatives/verify/${encodeURIComponent(token)}`
}

export async function representativeQrDataUrl(token: string, origin?: string | null, width = 512) {
  const url = representativeVerifyUrl(token, origin)
  return QRCode.toDataURL(url, {
    margin: 4,
    width,
    color: { dark: '#0f2b46', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  })
}

function representativePublicAssetUrl(row: any, asset: 'profilePhoto' | 'officialCard') {
  if (!row?.slug) return null
  const storageProvider = asset === 'profilePhoto' ? row.profilePhotoStorageProvider : row.officialCardStorageProvider
  const storageKey = asset === 'profilePhoto' ? row.profilePhotoStorageKey : row.officialCardStorageKey
  if (!storageProvider || !storageKey) return null
  return `/api/representatives/${encodeURIComponent(row.slug)}/asset/${asset}`
}

function representativePublicFileUrl(row: any, file: any) {
  if (!row?.slug || !file?.id || !file.storageProvider || !file.storageKey) return null
  if (file.storageProvider === 'external-url') return null
  return `/api/representatives/${encodeURIComponent(row.slug)}/files/${encodeURIComponent(file.id)}`
}

function approvedPublicFiles(row: any): RepresentativePublicFile[] {
  return Array.isArray(row.files) ? row.files
    .filter((file: any) => (file.reviewStatus || 'APPROVED') === 'APPROVED')
    .map((file: any) => ({
      id: file.id,
      kind: file.kind,
      title: file.title,
      description: file.description,
      externalUrl: file.externalUrl,
      fileUrl: representativePublicFileUrl(row, file) || (file.storageKey ? null : file.fileUrl),
    })) : []
}

export function formatRepresentativeDate(value?: Date | string | null) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function representativeCardStatus(row: any, now = new Date()) {
  const rawStatus = String(row?.status || '').toUpperCase()
  const validUntil = row?.validUntil ? new Date(row.validUntil) : null
  if (validUntil && !Number.isNaN(validUntil.getTime()) && validUntil.getTime() < now.getTime()) {
    return { code: 'EXPIRED', label: 'منتهي الصلاحية ❌', message: 'انتهت صلاحية بطاقة هذا الممثل، ولا تُعد سارية حالياً.', active: false }
  }
  if (rawStatus === 'ACTIVE') {
    return { code: 'ACTIVE', label: 'فعّال — ممثل معتمد ✅', message: 'بطاقة الممثل فعّالة ومعتمدة حالياً لدى الأكاديمية.', active: true }
  }
  return { code: 'SUSPENDED', label: 'موقوف / غير ساري ❌', message: 'بطاقة هذا الممثل موقوفة أو غير سارية حالياً لدى الأكاديمية.', active: false }
}

export function serializeRepresentativePublicCard(row: any, origin?: string | null) {
  const token = row.qrToken || null
  const cardStatus = representativeCardStatus(row)
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    cardStatus: cardStatus.code,
    statusLabel: cardStatus.label,
    statusMessage: cardStatus.message,
    active: cardStatus.active,
    cardNumber: row.cardNumber,
    validFrom: formatRepresentativeDate(row.validFrom),
    validUntil: formatRepresentativeDate(row.validUntil),
    fullName: row.fullName,
    displayTitle: row.displayTitle,
    degreeTitle: row.degreeTitle,
    academicRank: row.academicRank,
    country: row.country,
    region: row.region,
    territory: row.territory,
    city: row.city,
    specialization: row.specialization,
    representativeRole: row.representativeRole,
    profilePhotoUrl: representativePublicAssetUrl(row, 'profilePhoto') || row.profilePhotoUrl,
    officialCardUrl: representativePublicAssetUrl(row, 'officialCard') || row.officialCardUrl,
    verifyUrl: token ? representativeVerifyUrl(token, origin) : null,
    verifiedAt: new Date().toISOString(),
    academy: {
      name: 'الأكاديمية الأمريكية للاستشارات والتدريب',
      url: String(process.env.NEXT_PUBLIC_APP_URL || origin || '').replace(/\/+$/, ''),
    },
  }
}

export function serializeRepresentativeExpanded(row: any, origin?: string | null) {
  return {
    ...serializeRepresentativePublicCard(row, origin),
    phone: row.phone,
    email: row.email,
    whatsapp: row.whatsapp,
    website: row.website,
    shortBio: row.shortBio,
    professionalBio: row.professionalBio,
    worksSummary: row.worksSummary,
    achievements: row.achievements,
    publicContactNote: row.publicContactNote,
    files: approvedPublicFiles(row),
  }
}

export function serializeRepresentative(row: any, origin?: string | null, includeToken = false): RepresentativePublicProfile {
  const token = row.qrToken || null
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    fullName: row.fullName,
    displayTitle: row.displayTitle,
    degreeTitle: row.degreeTitle,
    academicRank: row.academicRank,
    country: row.country,
    region: row.region,
    territory: row.territory,
    city: row.city,
    specialization: row.specialization,
    representativeRole: row.representativeRole,
    shortBio: row.shortBio,
    professionalBio: row.professionalBio,
    worksSummary: row.worksSummary,
    achievements: row.achievements,
    publicContactNote: row.publicContactNote,
    phone: row.phone,
    email: row.email,
    whatsapp: row.whatsapp,
    website: row.website,
    profilePhotoUrl: representativePublicAssetUrl(row, 'profilePhoto') || row.profilePhotoUrl,
    officialCardUrl: representativePublicAssetUrl(row, 'officialCard') || row.officialCardUrl,
    qrToken: includeToken ? token : null,
    verifyUrl: includeToken && token ? representativeVerifyUrl(token, origin) : null,
    featured: row.featured,
    sortOrder: row.sortOrder,
    files: Array.isArray(row.files) ? row.files.filter((file: any) => includeToken || (file.reviewStatus || 'APPROVED') === 'APPROVED').map((file: any) => ({
      id: file.id,
      kind: file.kind,
      title: file.title,
      description: file.description,
      externalUrl: file.externalUrl,
      fileUrl: (file.reviewStatus || 'APPROVED') === 'APPROVED'
        ? (representativePublicFileUrl(row, file) || (file.storageKey ? null : file.fileUrl))
        : (includeToken && file.storageKey
          ? `/api/admin/representatives/${encodeURIComponent(row.id)}/files/${encodeURIComponent(file.id)}`
          : null),
      reviewStatus: includeToken ? (file.reviewStatus || 'APPROVED') : undefined,
      reviewNote: includeToken ? file.reviewNote : undefined,
    })) : [],
  }
}
