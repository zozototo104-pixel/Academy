import { z } from 'zod'

export const thesisDigestSchema = z.object({
  problem: z.string().default(''),
  objectives: z.array(z.string()).default([]),
  methodology: z.string().default(''),
  sample: z.string().default(''),
  tools: z.array(z.string()).default([]),
  keyFindings: z.array(z.string()).default([]),
  contributions: z.array(z.string()).default([]),
  literatureCoverage: z.string().default(''),
  referencesCount: z.number().int().min(0).default(0),
  weaknesses: z.array(z.string()).default([]),
  sectionMap: z.array(z.object({ title: z.string(), chunkFrom: z.number().int(), chunkTo: z.number().int() })).default([]),
})

export type ThesisDigest = z.infer<typeof thesisDigestSchema>
