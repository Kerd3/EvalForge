import 'dotenv/config';
import { z } from 'zod';

const optionalNumber = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().finite().nonnegative().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().default('postgres://evalforge:evalforge_dev_password@localhost:5432/evalforge'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  DEFAULT_OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_INPUT_COST_PER_1M_USD: optionalNumber,
  OPENAI_OUTPUT_COST_PER_1M_USD: optionalNumber,
  GEMINI_API_KEY: z.string().optional().default(''),
  DEFAULT_GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),
  // Ordered fallback chain used after Gemini quota/rate-limit errors or request timeouts.
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite'),
  // Per-request Gemini HTTP timeout; model fallback handles timeout failures.
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(180000).default(45000),
  // How long to avoid a model after a request timeout before trying it again.
  GEMINI_DEFAULT_TIMEOUT_COOLDOWN_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  // How long to avoid a Gemini model after a temporary service error such as HTTP 503.
  GEMINI_DEFAULT_UNAVAILABLE_COOLDOWN_MS: z.coerce.number().int().min(1000).max(3600000).default(30000),
  // Conservative spacing for free-tier projects. This setting applies across Gemini models.
  GEMINI_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(300000).default(13000),
  // When a 429 has no retry hint, temporarily avoid the model before trying it again.
  GEMINI_DEFAULT_QUOTA_COOLDOWN_MS: z.coerce.number().int().min(1000).max(86400000).default(60000),
  GEMINI_INPUT_COST_PER_1M_USD: optionalNumber,
  GEMINI_OUTPUT_COST_PER_1M_USD: optionalNumber,
  MODEL_COST_RATES_JSON: z.string().default(''),
  EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  EVAL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  EVAL_LOCK_DURATION_MS: z.coerce.number().int().min(30000).default(120000)
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration. Check .env.example.');
}

const rateEntrySchema = z.object({
  inputPer1MUsd: z.number().finite().nonnegative().optional(),
  outputPer1MUsd: z.number().finite().nonnegative().optional()
}).strict().refine((entry) => entry.inputPer1MUsd !== undefined || entry.outputPer1MUsd !== undefined, {
  message: 'A model rate entry must include inputPer1MUsd, outputPer1MUsd, or both.'
});
const modelCostRatesSchema = z.record(z.record(rateEntrySchema));
let modelCostRates = {};
if (parsed.data.MODEL_COST_RATES_JSON.trim()) {
  let json;
  try {
    json = JSON.parse(parsed.data.MODEL_COST_RATES_JSON);
  } catch {
    console.error('Invalid MODEL_COST_RATES_JSON: expected a valid JSON object.');
    throw new Error('Invalid MODEL_COST_RATES_JSON. Check .env.example for the expected format.');
  }
  const ratesParsed = modelCostRatesSchema.safeParse(json);
  if (!ratesParsed.success) {
    console.error('Invalid MODEL_COST_RATES_JSON:', ratesParsed.error.flatten());
    throw new Error('Invalid model cost rate configuration. Each entry may contain non-negative inputPer1MUsd and/or outputPer1MUsd values.');
  }
  modelCostRates = ratesParsed.data;
}

export const env = { ...parsed.data, MODEL_COST_RATES: modelCostRates };
