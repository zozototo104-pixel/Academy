import { db } from '@/lib/db'

export async function ensureAccreditationProfile() {
  return db.accreditationProfile.upsert({
    where: { singletonKey: 'default' },
    create: {
      singletonKey: 'default',
      trustNote: 'تُعرض هنا فقط بيانات الاعتماد والشراكات التي أدخلتها الإدارة وتملك لها رابط تحقق أو وثيقة منشورة.',
    },
    update: {},
  })
}

export function serializeAccreditationDocument(doc: any) {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    description: doc.description || '',
    verifyUrl: doc.verifyUrl || '',
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    fileUrl: doc.fileUrl || '',
    active: doc.active !== false,
    displayOrder: doc.displayOrder || 0,
    partnershipId: doc.partnershipId || null,
    createdAt: doc.createdAt,
    previewUrl: `/api/accreditation/documents/${doc.id}`,
    downloadUrl: `/api/accreditation/documents/${doc.id}?download=1`,
  }
}

export function serializeAccreditationPartnership(partner: any) {
  return {
    id: partner.id,
    name: partner.name,
    type: partner.type || '',
    description: partner.description || '',
    verifyUrl: partner.verifyUrl || '',
    active: partner.active !== false,
    displayOrder: partner.displayOrder || 0,
    documents: Array.isArray(partner.documents) ? partner.documents.map(serializeAccreditationDocument) : [],
  }
}

export function serializeAccreditationProfile(profile: any) {
  return {
    id: profile.id,
    licenseNumber: profile.licenseNumber || '',
    licenseVerifyUrl: profile.licenseVerifyUrl || '',
    licensingAuthority: profile.licensingAuthority || '',
    trustNote: profile.trustNote || '',
    partnerships: Array.isArray(profile.partnerships) ? profile.partnerships.map(serializeAccreditationPartnership) : [],
    documents: Array.isArray(profile.documents) ? profile.documents.map(serializeAccreditationDocument) : [],
  }
}

export async function getAccreditationProfileForAdmin() {
  const profile = await ensureAccreditationProfile()
  const full = await db.accreditationProfile.findUnique({
    where: { id: profile.id },
    include: {
      partnerships: {
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        include: { documents: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
      },
      documents: {
        where: { partnershipId: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      },
    },
  })
  return serializeAccreditationProfile(full || profile)
}

export async function getAccreditationProfileForPublic() {
  const profile = await db.accreditationProfile.findUnique({
    where: { singletonKey: 'default' },
    include: {
      partnerships: {
        where: { active: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        include: { documents: { where: { active: true }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
      },
      documents: {
        where: { active: true, partnershipId: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      },
    },
  })
  return profile ? serializeAccreditationProfile(profile) : serializeAccreditationProfile({})
}
