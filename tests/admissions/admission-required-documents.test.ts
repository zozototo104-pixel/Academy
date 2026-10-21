import { describe, expect, test } from 'bun:test'
import { parseAdmissionRules, resolveAdmissionRequiredDocuments } from '@/lib/admission-required-documents'

function missingTypes(requiredTypes: string[], uploadedTypes: string[]) {
  const uploaded = new Set(uploadedTypes)
  return requiredTypes.filter((type) => !uploaded.has(type))
}

describe('admission required documents', () => {
  test('explicit required documents from object require every selected document', () => {
    const rules = parseAdmissionRules({ requiredDocuments: ['DEGREE', 'PHOTO'] })
    const { requiredDocs } = resolveAdmissionRequiredDocuments({
      slug: 'mental-health-family-counseling',
      category: 'DIPLOMA',
      admissionRules: rules,
      isServiceRequest: false,
    })
    const requiredTypes = requiredDocs.map((doc) => doc.type)

    expect(requiredTypes).toEqual(['DEGREE', 'PHOTO'])
    expect(missingTypes(requiredTypes, ['DEGREE'])).toEqual(['PHOTO'])
    expect(missingTypes(requiredTypes, ['DEGREE', 'PHOTO'])).toEqual([])
  })

  test('explicit required documents from JSON string require every selected document', () => {
    const rules = parseAdmissionRules(JSON.stringify({ requiredDocuments: ['DEGREE', 'PHOTO'] }))
    const { requiredDocs } = resolveAdmissionRequiredDocuments({
      slug: 'mental-health-family-counseling',
      category: 'DIPLOMA',
      admissionRules: rules,
      isServiceRequest: false,
    })
    const requiredTypes = requiredDocs.map((doc) => doc.type)

    expect(requiredTypes).toEqual(['DEGREE', 'PHOTO'])
    expect(missingTypes(requiredTypes, ['DEGREE'])).toEqual(['PHOTO'])
    expect(missingTypes(requiredTypes, ['DEGREE', 'PHOTO'])).toEqual([])
  })

  test('program without custom admission rules keeps the current default requirements', () => {
    const { requiredDocs } = resolveAdmissionRequiredDocuments({
      slug: 'mental-health-family-counseling',
      category: 'DIPLOMA',
      admissionRules: parseAdmissionRules(null),
      isServiceRequest: false,
    })

    expect(requiredDocs.map((doc) => doc.type)).toEqual(['DEGREE', 'ID', 'PHOTO', 'CV'])
  })
})
