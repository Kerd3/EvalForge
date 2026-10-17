import { createAgentTrace } from '../services/agent-trace.service.js';

/**
 * Convert a caller-owned, completed event log into EvalForge's data-only trace.
 * Event types are intentionally explicit; unknown events are ignored.
 * No event handler or tool is invoked.
 */
export function adaptAgentEventLog({ events = [], finalAnswer = '', toolCalls = [] } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const retrievalResults = [];
  const citations = [];
  const proposedToolCalls = [...toolCalls];
  const executedToolResults = [];
  const intermediateSteps = [];

  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    switch (event.type) {
      case 'retrieval':
      case 'retrieval_result':
        retrievalResults.push({
          evidenceId: event.evidenceId ?? event.id,
          content: event.content,
          ...(event.rank !== undefined ? { rank: event.rank } : {}),
          ...(event.score !== undefined ? { score: event.score } : {}),
          ...(event.source !== undefined ? { source: event.source } : {})
        });
        break;
      case 'citation':
        citations.push({ evidenceId: event.evidenceId, ...(event.quote !== undefined ? { quote: event.quote } : {}) });
        break;
      case 'tool_call_proposed':
      case 'tool_call':
        proposedToolCalls.push({ ...(event.id !== undefined ? { id: event.id } : {}), name: event.name, arguments: event.arguments ?? {} });
        break;
      case 'tool_result':
      case 'tool_call_completed':
        executedToolResults.push({
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          name: event.name,
          ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
          result: event.result
        });
        break;
      case 'intermediate_step':
        intermediateSteps.push({
          stepId: event.stepId ?? event.id,
          content: event.content ?? '',
          ...(event.conclusion !== undefined ? { conclusion: event.conclusion } : {}),
          evidenceIds: event.evidenceIds ?? []
        });
        break;
      default:
        break;
    }
  }

  return {
    content: finalAnswer,
    toolCalls,
    agentTrace: createAgentTrace({ retrievalResults, citations, proposedToolCalls, executedToolResults, intermediateSteps })
  };
}

/** Build one recorded-evaluation request body from finished per-case outputs. */
export function createRecordedEvaluationPayload({ datasetVersionId, source, model, cases }) {
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array');
  return {
    dataset_version_id: datasetVersionId,
    source,
    model,
    responses: cases.map(({ testCaseId, response, events = [], finalAnswer, toolCalls, latencyMs, inputTokens, outputTokens, actualModel }) => {
      const adapted = response ?? adaptAgentEventLog({ events, finalAnswer, toolCalls });
      return {
        test_case_id: testCaseId,
        response: {
          content: adapted.content ?? '',
          toolCalls: adapted.toolCalls ?? [],
          agentTrace: adapted.agentTrace
        },
        ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
        ...(actualModel ? { actual_model: actualModel } : {})
      };
    })
  };
}
