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

function verificationSecret() {
  return process.env.AACT_REPRESENTATIVE_CARD_SECRET || process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET || 'aact-representative-local-secret'
}

export function normalizeLast4(value?: string | null) {
  const digits = String(value || '').replace(/\D+/g, '')
  if (digits.length >= 4) return digits.slice(-4)
  const clean = String(value || '').trim().toLowerCase()
  return clean.length >= 4 ? clean.slice(-4) : ''
}

export function hashRepresentativeVerifier(value?: string | null) {
  const last4 = normalizeLast4(value)
  if (!last4) return null
  return createHash('sha256').update(`${verificationSecret()}:${last4}`).digest('hex')
}

export function verifyRepresentativeLast4(input: string, phoneHash?: string | null, emailHash?: string | null) {
  const candidate = hashRepresentativeVerifier(input)
  if (!candidate) return false
  const checks = [phoneHash, emailHash].filter(Boolean) as string[]
  return checks.some((stored) => {
    try {
      const a = Buffer.from(candidate, 'hex')
      const b = Buffer.from(stored, 'hex')
      return a.length === b.length && timingSafeEqual(a, b)
    } catch {
      return false
    }
  })
}

export function representativeVerifyUrl(token: string, origin?: string | null) {
  const base = String(origin || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return `${base || ''}/representatives/verify/${encodeURIComponent(token)}`
}

export async function representativeQrDataUrl(token: string, origin?: string | null) {
  const url = representativeVerifyUrl(token, origin)
  return QRCode.toDataURL(url || `/representatives/verify/${encodeURIComponent(token)}`, {
    margin: 1,
    width: 320,
    color: { dark: '#0f2b46', light: '#ffffff' },
  })
}

function representativePublicAssetUrl(row: any, asset: 'profilePhoto' | 'officialCard') {
  if (!row?.id) return null
  const storageProvider = asset === 'profilePhoto' ? row.profilePhotoStorageProvider : row.officialCardStorageProvider
  const storageKey = asset === 'profilePhoto' ? row.profilePhotoStorageKey : row.officialCardStorageKey
  if (!storageProvider || !storageKey) return null
  return `/api/representatives/${encodeURIComponent(row.id)}/asset/${asset}`
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
    files: Array.isArray(row.files) ? row.files.map((file: any) => ({
      id: file.id,
      kind: file.kind,
      title: file.title,
      description: file.description,
      externalUrl: file.externalUrl,
      fileUrl: file.fileUrl,
    })) : [],
  }
}
