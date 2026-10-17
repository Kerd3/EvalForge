import { describe, expect, it, vi } from 'vitest';
import { makePolicyChunks, retrievePolicyEvidence, runPolicyRagCase, buildPolicyRagSubmission } from '../../examples/policy-rag-workflow.js';

describe('policy RAG example workflow', () => {
  const chunks = makePolicyChunks('Damaged items must be reported within 7 days. Eligible returns are allowed within 30 days.', 'policy');

  it('retrieves the damage deadline passage for a damage question', () => {
    const results = retrievePolicyEvidence('When should I report a damaged item?', chunks, 2);
    expect(results[0].content).toContain('7 days');
    expect(results[0].evidenceId).toBe('policy/chunk-1');
  });

  it('passes retrieved evidence to generation and captures its citation as trace data', async () => {
    const generate = vi.fn().mockImplementation(async ({ testCase }) => {
      expect(testCase.input.context).toContain('[policy/chunk-1]');
      return {
        content: JSON.stringify({
          answer: 'Report within 7 days. [policy/chunk-1]',
          citations: [{ evidenceId: 'policy/chunk-1', quote: 'within 7 days' }]
        }),
        toolCalls: [], usage: { inputTokens: 12, outputTokens: 8 },
        providerMetadata: { actualModel: 'test-model' }
      };
    });
    const result = await runPolicyRagCase({
      testCase: { id: 'case-1', input: { message: 'When do I report damage?' } }, chunks, generate
    });
    expect(result.content).toContain('Report within 7 days');
    expect(result.agentTrace.retrievalResults[0].evidenceId).toBe('policy/chunk-1');
    expect(result.agentTrace.citations).toEqual([{ evidenceId: 'policy/chunk-1', quote: 'within 7 days' }]);
    const payload = buildPolicyRagSubmission({
      datasetVersionId: '11111111-1111-4111-8111-111111111111', source: 'test', model: 'test-model',
      cases: [{ testCaseId: '22222222-2222-4222-8222-222222222222', result, latencyMs: 42, inputTokens: 12, outputTokens: 8 }]
    });
    expect(payload.responses[0]).toMatchObject({
      actual_model: 'test-model', response: { agentTrace: { schemaVersion: 'evalforge.agent-trace/v1' } }
    });
  });
});
