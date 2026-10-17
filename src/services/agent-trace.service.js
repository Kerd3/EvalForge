import { AGENT_TRACE_SCHEMA_VERSION, agentTraceSchema } from '../validators/agent-trace.schema.js';

const MAX_TRACE_BYTES = 100_000;

/**
 * Validate a versioned, data-only agent/RAG trace. No trace content is run.
 */
export function validateAgentTrace(value) {
  if (value === null || value === undefined) return { success: false, error: 'Agent trace was not supplied.' };
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { success: false, error: 'Agent trace must be JSON-serializable.' };
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_TRACE_BYTES) {
    return { success: false, error: `Agent trace exceeds the ${MAX_TRACE_BYTES}-byte limit.` };
  }
  const parsed = agentTraceSchema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'trace'}: ${issue.message}`).join('; ') };
}

export function createAgentTrace({
  retrievalResults = [], citations = [], proposedToolCalls = [], executedToolResults = [], intermediateSteps = []
} = {}) {
  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    retrievalResults,
    citations,
    proposedToolCalls,
    executedToolResults,
    intermediateSteps
  };
}
