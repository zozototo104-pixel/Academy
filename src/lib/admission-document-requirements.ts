import { resolveRules } from '@/lib/admission-ai'
import { parseAdmissionRules, resolveAdmissionRequiredDocuments, type AdmissionDocumentOption } from '@/lib/admission-required-documents'
import { buildServiceAdmissionDefaults, getServiceFlow } from '@/lib/service-flows'

export type AdmissionProgramRulesSource = {
  slug?: string | null
  category?: string | null
  admissionRules?: unknown
}

export type ResolvedAdmissionDocumentRequirements = {
  requiredDocs: AdmissionDocumentOption[]
  missingDocs: AdmissionDocumentOption[]
  allKnownDocs: AdmissionDocumentOption[]
  isServiceRequest: boolean
  programRules: unknown
}

export function resolveProgramAdmissionDocumentRequirements(
  program: AdmissionProgramRulesSource | null | undefined,
  uploadedTypesInput: Iterable<string> = []
): ResolvedAdmissionDocumentRequirements {
  const serviceFlow = getServiceFlow(program?.slug || undefined)
  const isServiceRequest = serviceFlow ? !serviceFlow.isStudyProgram : program?.category === 'SERVICE'
  const parsedAdmissionRules = parseAdmissionRules(program?.admissionRules)
  const programRules = parsedAdmissionRules
    ? resolveRules(program?.category || 'DIPLOMA', parsedAdmissionRules, !isServiceRequest)
    : (buildServiceAdmissionDefaults(serviceFlow) || resolveRules(program?.category || 'DIPLOMA', parsedAdmissionRules, !isServiceRequest))
  const { requiredDocs } = resolveAdmissionRequiredDocuments({
    slug: program?.slug,
    category: program?.category,
    admissionRules: programRules,
    isServiceRequest,
  })
  const uploadedTypes = new Set(Array.from(uploadedTypesInput).filter(Boolean))
  const missingDocs = requiredDocs.filter((doc) => !uploadedTypes.has(doc.type))
  return { requiredDocs, missingDocs, isServiceRequest, programRules }
}

const CLOSED_REPLACEMENT_PREVIOUS_STATUSES = new Set(['DOCUMENTS_NEED_REPLACEMENT', 'CERTIFIED', 'REJECTED'])

export function resolvePostReplacementAdmissionStatus(previousStatus: string | null | undefined, isServiceRequest: boolean): string {
  const safePrevious = previousStatus && !CLOSED_REPLACEMENT_PREVIOUS_STATUSES.has(previousStatus)
    ? previousStatus
    : 'UNDER_REVIEW'
  if (safePrevious === 'UPLOADING_DOCUMENTS' || safePrevious === 'STAGED') {
    return isServiceRequest ? 'UNDER_REVIEW' : 'AWAITING_FEE'
  }
  return safePrevious
}
