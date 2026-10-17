import { describe, expect, it } from 'vitest';
import { adaptAgentEventLog, createRecordedEvaluationPayload } from '../../src/adapters/agent-trace.adapter.js';

describe('recorded agent trace adapter', () => {
  it('maps finished event data and never invokes tools', () => {
    const result = adaptAgentEventLog({
      finalAnswer: 'Report within seven days.',
      events: [
        { type: 'retrieval', id: 'policy-1', content: 'Report within seven days.' },
        { type: 'citation', evidenceId: 'policy-1', quote: 'within seven days' },
        { type: 'tool_call_proposed', name: 'lookup_order', arguments: { orderId: 'A-1' } },
        { type: 'tool_result', name: 'lookup_order', arguments: { orderId: 'A-1' }, result: { status: 'found' } },
        { type: 'intermediate_step', id: 'step-1', content: 'Read the policy', evidenceIds: ['policy-1'] }
      ]
    });
    expect(result.agentTrace).toMatchObject({
      schemaVersion: 'evalforge.agent-trace/v1',
      retrievalResults: [{ evidenceId: 'policy-1' }],
      citations: [{ evidenceId: 'policy-1' }],
      proposedToolCalls: [{ name: 'lookup_order' }],
      executedToolResults: [{ name: 'lookup_order' }],
      intermediateSteps: [{ stepId: 'step-1' }]
    });
  });

  it('builds the endpoint payload from completed case outputs', () => {
    const payload = createRecordedEvaluationPayload({
      datasetVersionId: '11111111-1111-4111-8111-111111111111', source: 'my-rag', model: 'agent-v2',
      cases: [{ testCaseId: '22222222-2222-4222-8222-222222222222', finalAnswer: 'Answer', events: [] }]
    });
    expect(payload.responses[0].response).toMatchObject({
      content: 'Answer', agentTrace: { schemaVersion: 'evalforge.agent-trace/v1' }
    });
  });
});
