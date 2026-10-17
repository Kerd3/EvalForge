import { z } from 'zod';
import { agentTraceSchema, traceGradingRulesSchema } from './agent-trace.schema.js';

const toolSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(1000).default(''),
  parameters: z.record(z.unknown()).default({ type: 'object', properties: {} })
}).strict();

const goldenToolCallSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.unknown()).optional()
}).passthrough();

const goldenExampleSchema = z.object({
  label: z.enum(['correct', 'incorrect', 'ambiguous', 'conflicting', 'adversarial']),
  response: z.object({
    content: z.string().max(20000).default(''),
    toolCalls: z.array(goldenToolCallSchema).max(30).default([]),
    agentTrace: agentTraceSchema.optional()
  }).strict(),
  expected_passed: z.boolean(),
  rationale: z.string().max(1000).optional()
}).strict();

const testCaseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  input: z.union([z.string().max(20000), z.record(z.unknown())]),
  expected_output: z.unknown().optional(),
  required_keywords: z.array(z.string().min(1).max(200)).max(50).default([]),
  forbidden_keywords: z.array(z.string().min(1).max(200)).max(50).default([]),
  required_tools: z.array(z.string().min(1).max(100)).max(30).default([]),
  forbidden_tools: z.array(z.string().min(1).max(100)).max(30).default([]),
  tools: z.array(toolSchema).max(30).default([]),
  grading_rules: z.object({
    exactMatch: z.boolean().optional(),
    expectedOutputContains: z.string().optional(),
    validJson: z.boolean().optional(),
    mustAbstain: z.boolean().optional(),
    judgeEnabled: z.boolean().optional(),
    judgeRubric: z.string().max(3000).optional(),
    semanticEquivalents: z.array(z.string().min(1).max(20000)).max(25).optional(),
    requiredKeywords: z.array(z.string().min(1).max(200)).max(50).optional(),
    forbiddenKeywords: z.array(z.string().min(1).max(200)).max(50).optional(),
    traceRules: traceGradingRulesSchema.optional()
  }).default({}),
  // These examples are immutable with their dataset version and are used to
  // measure deterministic-grader calibration, including false positives/negatives.
  golden_examples: z.array(goldenExampleSchema).max(20).default([])
}).strict();

export const createDatasetSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).default(''),
  test_cases: z.array(testCaseSchema).min(1).max(500)
}).strict();
