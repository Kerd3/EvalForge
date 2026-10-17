import { z } from 'zod';

export const AGENT_TRACE_SCHEMA_VERSION = 'evalforge.agent-trace/v1';
const idSchema = z.string().trim().min(1).max(200);
const jsonObjectSchema = z.record(z.unknown());
const jsonResultSchema = z.union([
  z.string().max(20_000), z.number().finite(), z.boolean(), z.null(), jsonObjectSchema, z.array(z.unknown())
]);

const retrievalResultSchema = z.object({
  evidenceId: idSchema,
  content: z.string().max(20_000),
  rank: z.number().int().positive().optional(),
  score: z.number().finite().optional(),
  source: z.string().max(500).optional()
}).strict();

const citationSchema = z.object({
  evidenceId: idSchema,
  quote: z.string().max(5_000).optional()
}).strict();

const toolCallSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(100),
  arguments: jsonObjectSchema.default({})
}).strict();

const toolResultSchema = z.object({
  callId: idSchema.optional(),
  name: z.string().trim().min(1).max(100),
  arguments: jsonObjectSchema.optional(),
  result: jsonResultSchema
}).strict();

const intermediateStepSchema = z.object({
  stepId: idSchema,
  content: z.string().max(20_000),
  conclusion: z.string().max(2_000).optional(),
  evidenceIds: z.array(idSchema).max(100).default([])
}).strict();

/** Data-only recorded agent/RAG trace. No field is executed by EvalForge. */
export const agentTraceSchema = z.object({
  schemaVersion: z.literal(AGENT_TRACE_SCHEMA_VERSION),
  retrievalResults: z.array(retrievalResultSchema).max(100).default([]),
  citations: z.array(citationSchema).max(100).default([]),
  proposedToolCalls: z.array(toolCallSchema).max(30).default([]),
  executedToolResults: z.array(toolResultSchema).max(30).default([]),
  intermediateSteps: z.array(intermediateStepSchema).max(100).default([])
}).strict();

const evidenceClaimRuleSchema = z.object({
  claim: z.string().trim().min(1).max(2_000),
  evidenceId: idSchema
}).strict();

const toolCallExpectationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  arguments: jsonObjectSchema.optional(),
  argumentMatch: z.enum(['exact', 'contains']).default('exact')
}).strict();

export const traceGradingRulesSchema = z.object({
  validateCitations: z.boolean().optional(),
  requiredEvidenceIds: z.array(idSchema).max(30).optional(),
  evidenceClaims: z.array(evidenceClaimRuleSchema).max(30).optional(),
  toolCallExpectations: z.array(toolCallExpectationSchema).max(30).optional(),
  stepConsistency: z.object({
    requireValidEvidenceIds: z.boolean().optional(),
    requireConclusionsInFinalAnswer: z.boolean().optional()
  }).strict().optional()
}).strict();
