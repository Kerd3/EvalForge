import { adaptAgentEventLog, createRecordedEvaluationPayload } from '../src/adapters/agent-trace.adapter.js';

const normalizeTerm = (word) => {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ed') && word.length > 4) {
    const stem = word.slice(0, -2);
    return stem.endsWith('g') ? `${stem}e` : stem;
  }
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
  return word;
};
const tokenize = (text) => (String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeTerm);

/** Make stable, inspectable policy sentence chunks from a supplied policy text. */
export function makePolicyChunks(text, source = 'policy-document') {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Policy text must be a non-empty string');
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/u).map((s) => s.trim()).filter(Boolean);
  return sentences.map((content, index) => ({ evidenceId: `policy/chunk-${index + 1}`, content, source }));
}

/** Lightweight TF-IDF retrieval for a local prototype. This performs real ranking over policy chunks. */
export function retrievePolicyEvidence(question, chunks, topK = 4) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const queryTerms = [...new Set(tokenize(question))];
  const documentTerms = chunks.map((chunk) => tokenize(chunk.content));
  const documentFrequency = new Map(queryTerms.map((term) => [term, documentTerms.filter((terms) => terms.includes(term)).length]));
  const ranked = chunks.map((chunk, index) => {
    const terms = documentTerms[index];
    const score = queryTerms.reduce((sum, term) => {
      const frequency = terms.filter((item) => item === term).length;
      if (!frequency) return sum;
      const inverseFrequency = Math.log(1 + chunks.length / (1 + documentFrequency.get(term)));
      return sum + (1 + Math.log(frequency)) * inverseFrequency;
    }, 0);
    return { ...chunk, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.evidenceId.localeCompare(b.evidenceId))
    .slice(0, Math.max(1, Math.min(10, topK)));
  const maxScore = ranked[0]?.score || 1;
  return ranked.map((chunk, index) => ({
    evidenceId: chunk.evidenceId, content: chunk.content, source: chunk.source,
    rank: index + 1, score: Number((chunk.score / maxScore).toFixed(4))
  }));
}

function parseModelAnswer(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  try {
    const candidate = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed.answer === 'string') {
      return { answer: parsed.answer, citations: Array.isArray(parsed.citations) ? parsed.citations : [] };
    }
  } catch { /* Preserve an unstructured answer as text; do not invent citations. */ }
  return { answer: text, citations: [] };
}

/** Retrieve evidence, call a supplied model, and return a completed inert trace. */
export async function runPolicyRagCase({ testCase, chunks, generate, topK = 4 }) {
  const question = typeof testCase.input === 'string' ? testCase.input : testCase.input?.message ?? '';
  const retrievalResults = retrievePolicyEvidence(question, chunks, topK);
  const evidenceBlock = retrievalResults.length
    ? retrievalResults.map((item) => `[${item.evidenceId}] ${item.content}`).join('\n')
    : '(No relevant policy passages were retrieved.)';
  const response = await generate({
    testCase: {
      ...testCase,
      input: { message: question, context: evidenceBlock },
      tools: []
    },
    systemPrompt: [
      'Answer the user using only the supplied retrieved policy passages.',
      'If they do not support an answer, say the policy does not specify and do not guess.',
      'Cite supporting passages using their exact evidence ID in square brackets.',
      'Return only JSON: {"answer":"...","citations":[{"evidenceId":"...","quote":"exact text from that passage"}]}.'
    ].join(' ')
  });
  const parsed = parseModelAnswer(response?.content);
  const events = retrievalResults.map((item) => ({ type: 'retrieval_result', ...item }));
  for (const citation of parsed.citations) events.push({ type: 'citation', ...citation });
  events.push({
    type: 'intermediate_step', id: 'retrieval-and-answer',
    content: `Retrieved ${retrievalResults.length} policy passage(s) and prepared the final answer.`,
    evidenceIds: retrievalResults.map((item) => item.evidenceId)
  });
  const adapted = adaptAgentEventLog({ events, finalAnswer: parsed.answer, toolCalls: response?.toolCalls ?? [] });
  return {
    ...adapted,
    usage: response?.usage,
    actualModel: response?.providerMetadata?.actualModel ?? response?.providerMetadata?.model ?? null
  };
}

export function buildPolicyRagSubmission({ datasetVersionId, source, model, cases }) {
  return createRecordedEvaluationPayload({
    datasetVersionId, source, model,
    cases: cases.map(({ testCaseId, result, latencyMs, inputTokens, outputTokens }) => ({
      testCaseId,
      finalAnswer: result.content,
      toolCalls: result.toolCalls,
      events: [
        ...result.agentTrace.retrievalResults.map((item) => ({ type: 'retrieval_result', ...item })),
        ...result.agentTrace.citations.map((item) => ({ type: 'citation', ...item })),
        ...result.agentTrace.proposedToolCalls.map((item) => ({ type: 'tool_call_proposed', ...item })),
        ...result.agentTrace.executedToolResults.map((item) => ({ type: 'tool_result', ...item })),
        ...result.agentTrace.intermediateSteps.map((item) => ({ type: 'intermediate_step', ...item, id: item.stepId }))
      ],
      latencyMs, inputTokens, outputTokens, actualModel: result.actualModel
    }))
  });
}
