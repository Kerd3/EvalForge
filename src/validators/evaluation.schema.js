import { z } from 'zod';
import { agentTraceSchema } from './agent-trace.schema.js';

export const createEvaluationSchema = z.object({
  dataset_id: z.string().uuid().optional(),
  dataset_version_id: z.string().uuid().optional(),
  provider: z.enum(['mock', 'openai', 'gemini']).default('mock'),
  model: z.string().trim().min(1).max(150).optional(),
  system_prompt: z.string().max(12000).default('You are being evaluated. Answer accurately, follow the instructions, and do not invent facts.')
}).strict().refine((value) => Boolean(value.dataset_id || value.dataset_version_id), {
  message: 'Provide dataset_id or dataset_version_id', path: ['dataset_id']
}).refine((value) => !(value.dataset_id && value.dataset_version_id), {
  message: 'Provide only one of dataset_id or dataset_version_id', path: ['dataset_id']
});

export const compareSchema = z.object({
  baseline_run_id: z.string().uuid(),
  candidate_run_id: z.string().uuid()
}).strict().refine((value) => value.baseline_run_id !== value.candidate_run_id, {
  message: 'Baseline and candidate run IDs must be different'
});

const recordedToolCallSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(100),
  arguments: z.record(z.unknown()).default({})
}).strict();

const recordedResponseSchema = z.object({
  content: z.string().max(20_000).default(''),
  toolCalls: z.array(recordedToolCallSchema).max(30).default([]),
  agentTrace: agentTraceSchema
}).strict();

export const createRecordedEvaluationSchema = z.object({
  dataset_version_id: z.string().uuid(),
  source: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(150),
  responses: z.array(z.object({
    test_case_id: z.string().uuid(),
    response: recordedResponseSchema,
    latency_ms: z.number().int().min(0).max(600_000).optional(),
    input_tokens: z.number().int().min(0).max(2_147_483_647).optional(),
    output_tokens: z.number().int().min(0).max(2_147_483_647).optional(),
    actual_model: z.string().trim().min(1).max(150).optional()
  }).strict()).min(1).max(500)
}).strict();

export const createEvaluationCampaignSchema = z.object({
  dataset_id: z.string().uuid().optional(),
  dataset_version_id: z.string().uuid().optional(),
  provider: z.enum(['mock', 'openai', 'gemini']).default('mock'),
  model: z.string().trim().min(1).max(150).optional(),
  system_prompt: z.string().max(12000).default('You are being evaluated. Answer accurately, follow the instructions, and do not invent facts.'),
  repeat_count: z.number().int().min(2).max(10).default(3)
}).strict().refine((value) => Boolean(value.dataset_id || value.dataset_version_id), {
  message: 'Provide dataset_id or dataset_version_id', path: ['dataset_id']
}).refine((value) => !(value.dataset_id && value.dataset_version_id), {
  message: 'Provide only one of dataset_id or dataset_version_id', path: ['dataset_id']
});
