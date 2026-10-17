import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  addAuditEvent: vi.fn(),
  getEvaluationById: vi.fn(),
  getEvaluationContext: vi.fn(),
  getResult: vi.fn(),
  markResultStarted: vi.fn(),
  saveEvaluationResult: vi.fn(),
  updateRunStatus: vi.fn()
}));

vi.mock('../../src/repositories/evaluations.repository.js', () => repository);

import { processEvaluationRun } from '../../src/services/evaluation-runner.service.js';

const agentTrace = {
  schemaVersion: 'evalforge.agent-trace/v1',
  retrievalResults: [{ evidenceId: 'policy', content: 'Report within 7 days.' }],
  citations: [{ evidenceId: 'policy', quote: 'within 7 days' }],
  proposedToolCalls: [{ name: 'lookup_order', arguments: { orderId: 'O-1' } }],
  executedToolResults: [],
  intermediateSteps: [{ stepId: 'step-1', content: 'Use policy evidence.', conclusion: 'within 7 days', evidenceIds: ['policy'] }]
};

const evaluationContext = {
  run: { id: 'run-1', status: 'queued', provider: 'mock', model: 'mock-v1', system_prompt: 'Be accurate.' },
  cases: [{
    id: 'case-1', name: 'Recorded RAG case',
    input: { message: 'When?', mock_response: { content: 'Report within 7 days.', agentTrace } },
    required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [],
    grading_rules: {
      traceRules: {
        requiredEvidenceIds: ['policy'], validateCitations: true,
        evidenceClaims: [{ claim: 'within 7 days', evidenceId: 'policy' }],
        toolCallExpectations: [{ name: 'lookup_order', arguments: { orderId: 'O-1' } }],
        stepConsistency: { requireValidEvidenceIds: true, requireConclusionsInFinalAnswer: true }
      }
    }
  }]
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.getEvaluationContext.mockResolvedValue(evaluationContext);
  repository.getEvaluationById.mockResolvedValue({ id: 'run-1', status: 'running', completed_cases: 1, total_cases: 1 });
  repository.getResult.mockResolvedValue(null);
  repository.updateRunStatus.mockResolvedValue(true);
});

describe('Phase 3 recorded trace evaluation run', () => {
  it('grades and persists the versioned trace as inert output data', async () => {
    await processEvaluationRun('run-1');

    const saved = repository.saveEvaluationResult.mock.calls[0][0];
    expect(saved.status).toBe('passed');
    expect(saved.actualOutput.agentTrace).toEqual(agentTrace);
    expect(saved.graders.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'agent_trace_contract', 'citation_validity', 'evidence_support',
      'missing_retrieval_evidence', 'tool_selection_and_arguments', 'intermediate_final_consistency'
    ]));
    expect(saved.graders.every(({ passed }) => passed)).toBe(true);
    expect(saved.trace.some(({ type }) => type === 'agent_trace.rejected')).toBe(false);
  });

  it('records validation failure without persisting a malformed raw trace', async () => {
    repository.getEvaluationContext.mockResolvedValue({
      ...evaluationContext,
      cases: [{
        ...evaluationContext.cases[0],
        input: {
          ...evaluationContext.cases[0].input,
          mock_response: {
            ...evaluationContext.cases[0].input.mock_response,
            agentTrace: { ...agentTrace, schemaVersion: 'evalforge.agent-trace/v2' }
          }
        }
      }]
    });

    await processEvaluationRun('run-1');

    const saved = repository.saveEvaluationResult.mock.calls[0][0];
    expect(saved.status).toBe('failed');
    expect(saved.actualOutput).not.toHaveProperty('agentTrace');
    expect(saved.actualOutput.agentTraceValidation).toMatchObject({ valid: false });
    expect(saved.trace.some(({ type }) => type === 'agent_trace.rejected')).toBe(true);
  });
});
