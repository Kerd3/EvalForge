import { describe, expect, it } from 'vitest';
import { createDatasetSchema } from '../../src/validators/dataset.schema.js';
import { createAgentTrace, validateAgentTrace } from '../../src/services/agent-trace.service.js';
import { gradeCase } from '../../src/services/grading.service.js';

const retrievedText = 'Damaged items must be reported within 7 calendar days of delivery.';

function makeTrace(overrides = {}) {
  return createAgentTrace({
    retrievalResults: [{ evidenceId: 'policy-damage', content: retrievedText, rank: 1 }],
    citations: [{ evidenceId: 'policy-damage', quote: 'within 7 calendar days' }],
    proposedToolCalls: [{ id: 'call-1', name: 'lookup_order', arguments: { orderId: 'A-123' } }],
    executedToolResults: [{ callId: 'call-1', name: 'lookup_order', arguments: { orderId: 'A-123' }, result: { found: true } }],
    intermediateSteps: [{
      stepId: 'step-1', content: 'Use the damage policy evidence.',
      conclusion: 'within 7 calendar days', evidenceIds: ['policy-damage']
    }],
    ...overrides
  });
}

function testCase(traceRules) {
  return {
    input: 'When must damage be reported?', required_keywords: [], forbidden_keywords: [],
    required_tools: [], forbidden_tools: [], grading_rules: { traceRules }
  };
}

function grade(rules, response = {}) {
  return gradeCase(testCase(rules), {
    content: 'Report damaged items within 7 calendar days of delivery.',
    toolCalls: [], agentTrace: makeTrace(), ...response
  });
}

describe('Phase 3 versioned agent trace contract', () => {
  it('accepts a complete bounded evalforge.agent-trace/v1 record', () => {
    expect(validateAgentTrace(makeTrace())).toMatchObject({ success: true });
  });

  it('rejects unknown schema versions, extra fields, and oversized traces', () => {
    expect(validateAgentTrace({ ...makeTrace(), schemaVersion: 'evalforge.agent-trace/v2' }).success).toBe(false);
    expect(validateAgentTrace({ ...makeTrace(), unexpected: true }).success).toBe(false);
    expect(validateAgentTrace(createAgentTrace({ retrievalResults: [{ evidenceId: 'large', content: 'x'.repeat(100_001) }] })).success).toBe(false);
    expect(validateAgentTrace(createAgentTrace({
      retrievalResults: Array.from({ length: 6 }, (_, index) => ({ evidenceId: `e-${index}`, content: 'x'.repeat(17_000) }))
    })).error).toContain('100000-byte limit');
  });

  it('accepts a dataset with trace graders and golden recorded traces', () => {
    const result = createDatasetSchema.safeParse({
      name: 'Recorded RAG trace', description: '',
      test_cases: [{
        input: 'question',
        grading_rules: { traceRules: { validateCitations: true, requiredEvidenceIds: ['policy-damage'] } },
        golden_examples: [{
          label: 'correct', expected_passed: true,
          response: { content: 'An answer', toolCalls: [], agentTrace: makeTrace() }
        }]
      }]
    });
    expect(result.success).toBe(true);
  });
});

describe('Phase 3 deterministic trace graders', () => {
  it('checks evidence support, citation validity, required retrieval, tool args, and step consistency', () => {
    const rules = {
      requiredEvidenceIds: ['policy-damage'],
      validateCitations: true,
      evidenceClaims: [{ claim: 'within 7 calendar days', evidenceId: 'policy-damage' }],
      toolCallExpectations: [{ name: 'lookup_order', arguments: { orderId: 'A-123' } }],
      stepConsistency: { requireValidEvidenceIds: true, requireConclusionsInFinalAnswer: true }
    };
    const result = grade(rules);
    expect(result.passed).toBe(true);
    expect(result.graders.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'agent_trace_contract', 'missing_retrieval_evidence', 'citation_validity',
      'evidence_support', 'tool_selection_and_arguments', 'intermediate_final_consistency'
    ]));
  });

  it('fails a citation that points to evidence that was not retrieved', () => {
    const result = grade({ validateCitations: true }, {
      agentTrace: makeTrace({ citations: [{ evidenceId: 'fabricated-source' }] })
    });
    expect(result.graders.find(({ name }) => name === 'citation_validity')).toMatchObject({ passed: false });
  });

  it('fails a citation quote that the retrieved evidence does not support', () => {
    const result = grade({ validateCitations: true }, {
      agentTrace: makeTrace({ citations: [{ evidenceId: 'policy-damage', quote: 'free replacement tomorrow' }] })
    });
    expect(result.graders.find(({ name }) => name === 'citation_validity')).toMatchObject({ passed: false });
  });

  it('fails when required retrieval evidence is missing', () => {
    const result = grade({ requiredEvidenceIds: ['policy-damage', 'missing-policy'] });
    expect(result.graders.find(({ name }) => name === 'missing_retrieval_evidence')).toMatchObject({ passed: false });
  });

  it('fails a selected tool with incorrect arguments', () => {
    const result = grade({
      toolCallExpectations: [{ name: 'lookup_order', arguments: { orderId: 'A-123', includeItems: true } }]
    });
    expect(result.graders.find(({ name }) => name === 'tool_selection_and_arguments')).toMatchObject({ passed: false });
  });

  it('fails when an intermediate conclusion is absent from the final answer or cites unknown evidence', () => {
    const result = grade({ stepConsistency: { requireValidEvidenceIds: true, requireConclusionsInFinalAnswer: true } }, {
      content: 'Contact support for help.',
      agentTrace: makeTrace({ intermediateSteps: [{
        stepId: 'step-1', content: 'Reasoning summary', conclusion: 'within 7 calendar days', evidenceIds: ['missing-source']
      }] })
    });
    expect(result.graders.find(({ name }) => name === 'intermediate_final_consistency')).toMatchObject({ passed: false });
  });

  it('fails closed for a missing trace when trace grading is configured', () => {
    const result = grade({ validateCitations: true, requiredEvidenceIds: ['policy-damage'] }, { agentTrace: undefined });
    expect(result.passed).toBe(false);
    expect(result.graders.find(({ name }) => name === 'agent_trace_contract')).toMatchObject({ passed: false });
  });

  it('validates any supplied trace even when no trace-specific rules were configured', () => {
    const result = gradeCase({ input: 'question', required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: {} }, {
      content: 'Answer', agentTrace: { ...makeTrace(), schemaVersion: 'evalforge.agent-trace/v2' }
    });
    expect(result.passed).toBe(false);
    expect(result.graders.find(({ name }) => name === 'agent_trace_contract')).toMatchObject({ passed: false });
  });
});
