import { describe, expect, test } from 'bun:test'
import { resolveRules } from '@/lib/admission-ai'
import { resolvePostReplacementAdmissionStatus, resolveProgramAdmissionDocumentRequirements } from '@/lib/admission-document-requirements'
import { parseAdmissionRules, resolveAdmissionRequiredDocuments } from '@/lib/admission-required-documents'
import { getDefaultRequiredServiceDocumentTypes, getServiceFlow } from '@/lib/service-flows'

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

  test('service rules with empty requiredDocuments fall back to default service flow documents', () => {
    const slug = 'accreditation-membership-license'
    const flow = getServiceFlow(slug)
    if (!flow) throw new Error('missing accreditation-membership-license service flow')
    const rules = resolveRules('SERVICE', {}, false)
    const { requiredDocs } = resolveAdmissionRequiredDocuments({
      slug,
      category: 'SERVICE',
      admissionRules: rules,
      isServiceRequest: true,
    })

    expect(requiredDocs.map((doc) => doc.type)).toEqual(getDefaultRequiredServiceDocumentTypes(flow))
    expect(requiredDocs.map((doc) => doc.type)).not.toEqual([])
  })

  test('service rules with explicit requiredDocuments use only the selected service documents', () => {
    const slug = 'accreditation-membership-license'
    const rules = resolveRules('SERVICE', { requiredDocuments: ['FLOW_DOC_1'] }, false)
    const { requiredDocs } = resolveAdmissionRequiredDocuments({
      slug,
      category: 'SERVICE',
      admissionRules: rules,
      isServiceRequest: true,
    })

    expect(requiredDocs.map((doc) => doc.type)).toEqual(['FLOW_DOC_1'])
  })

  test('missing document helper reports selected required documents that were not uploaded', () => {
    const result = resolveProgramAdmissionDocumentRequirements(
      { slug: 'mental-health-family-counseling', category: 'DIPLOMA', admissionRules: { requiredDocuments: ['DEGREE', 'PHOTO'] } },
      ['DEGREE']
    )

    expect(result.requiredDocs.map((doc) => doc.type)).toEqual(['DEGREE', 'PHOTO'])
    expect(result.missingDocs.map((doc) => doc.type)).toEqual(['PHOTO'])
  })

  test('replacement finalize status follows the normal application path for incomplete admissions', () => {
    expect(resolvePostReplacementAdmissionStatus('UPLOADING_DOCUMENTS', false)).toBe('AWAITING_FEE')
    expect(resolvePostReplacementAdmissionStatus('STAGED', false)).toBe('AWAITING_FEE')
    expect(resolvePostReplacementAdmissionStatus('UPLOADING_DOCUMENTS', true)).toBe('UNDER_REVIEW')
    expect(resolvePostReplacementAdmissionStatus('UNDER_REVIEW', false)).toBe('UNDER_REVIEW')
  })
})
