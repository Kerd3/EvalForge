import { z } from 'zod';

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
