import { validateAgentTrace } from './agent-trace.service.js';

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalize(value) {
  return asText(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function makeCheck(name, passed, details, score = passed ? 1 : 0, metadata = {}) {
  return { name, passed, score, details, ...metadata };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function deepEqualJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function includesJsonSubset(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      Object.hasOwn(actual, key) && includesJsonSubset(actual[key], value));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => includesJsonSubset(actual[index], value));
  }
  return Object.is(actual, expected);
}

function gradeTraceRules(response, rules) {
  const hasTrace = response?.agentTrace !== undefined && response?.agentTrace !== null;
  if ((!rules || typeof rules !== 'object') && !hasTrace) return [];
  const validation = validateAgentTrace(response?.agentTrace);
  const trace = validation.success ? validation.data : null;
  const graders = [makeCheck('agent_trace_contract', Boolean(trace), trace
    ? 'Agent trace matches evalforge.agent-trace/v1.'
    : validation.error)];
  if (!rules || typeof rules !== 'object') return graders;
  const evidenceById = new Map((trace?.retrievalResults ?? []).map((item) => [item.evidenceId, item]));
  const citedIds = new Set((trace?.citations ?? []).map((item) => item.evidenceId));
  const content = typeof response?.content === 'string' ? response.content : '';

  if (Array.isArray(rules.requiredEvidenceIds)) {
    const missing = rules.requiredEvidenceIds.filter((id) => !evidenceById.has(id));
    graders.push(makeCheck('missing_retrieval_evidence', Boolean(trace) && missing.length === 0,
      !trace ? 'Cannot check retrieval evidence because the agent trace is missing or invalid.'
        : missing.length ? `Required evidence was not retrieved: ${missing.join(', ')}` : 'All required evidence IDs were retrieved.'));
  }

  if (rules.validateCitations === true) {
    const invalid = (trace?.citations ?? []).filter((citation) => {
      const evidence = evidenceById.get(citation.evidenceId);
      return !evidence || (citation.quote !== undefined && !containsPhrase(evidence.content, citation.quote));
    });
    graders.push(makeCheck('citation_validity', Boolean(trace) && invalid.length === 0,
      !trace ? 'Cannot validate citations because the agent trace is missing or invalid.'
        : invalid.length
          ? `Citations do not match retrieved evidence: ${invalid.map((item) => item.evidenceId).join(', ')}`
          : 'Every citation points to retrieved evidence; supplied quotes occur in that evidence.'));
  }

  if (Array.isArray(rules.evidenceClaims)) {
    const unsupported = rules.evidenceClaims.filter((item) => {
      const evidence = evidenceById.get(item.evidenceId);
      return !evidence || !citedIds.has(item.evidenceId)
        || !containsPhrase(evidence.content, item.claim)
        || !containsPhrase(content, item.claim);
    });
    graders.push(makeCheck('evidence_support', Boolean(trace) && unsupported.length === 0,
      !trace ? 'Cannot check evidence support because the agent trace is missing or invalid.'
        : unsupported.length
          ? `Claims were missing from the answer, their cited evidence, or the retrieval trace: ${unsupported.map((item) => `${item.claim} (${item.evidenceId})`).join('; ')}`
          : 'Each required claim appears in the final answer and its cited, retrieved evidence.'));
  }

  if (Array.isArray(rules.toolCallExpectations)) {
    const proposed = trace ? trace.proposedToolCalls : (Array.isArray(response?.toolCalls) ? response.toolCalls : []);
    const missing = rules.toolCallExpectations.filter((expected) => !proposed.some((actual) => {
      if (actual?.name !== expected.name) return false;
      if (expected.arguments === undefined) return true;
      return expected.argumentMatch === 'contains'
        ? includesJsonSubset(actual.arguments ?? {}, expected.arguments)
        : deepEqualJson(actual.arguments ?? {}, expected.arguments);
    }));
    graders.push(makeCheck('tool_selection_and_arguments', Boolean(trace) && missing.length === 0,
      !trace ? 'Cannot verify tool selection or arguments because the agent trace is missing or invalid.'
        : missing.length
          ? `Expected tool calls were missing or had invalid arguments: ${missing.map((item) => item.name).join(', ')}`
          : 'Expected tools were selected with matching arguments.'));
  }

  if (rules.stepConsistency && typeof rules.stepConsistency === 'object') {
    const consistencyFailures = [];
    if (trace && trace.intermediateSteps.length === 0
      && (rules.stepConsistency.requireValidEvidenceIds === true
        || rules.stepConsistency.requireConclusionsInFinalAnswer === true)) {
      consistencyFailures.push('No intermediate steps were supplied.');
    }
    if (rules.stepConsistency.requireValidEvidenceIds === true && trace) {
      for (const step of trace.intermediateSteps) {
        const missing = step.evidenceIds.filter((id) => !evidenceById.has(id));
        if (missing.length) consistencyFailures.push(`${step.stepId} references unknown evidence: ${missing.join(', ')}`);
      }
    }
    if (rules.stepConsistency.requireConclusionsInFinalAnswer === true && trace) {
      for (const step of trace.intermediateSteps) {
        if (step.conclusion && !containsPhrase(content, step.conclusion)) {
          consistencyFailures.push(`${step.stepId} conclusion is absent from the final answer`);
        }
      }
    }
    graders.push(makeCheck('intermediate_final_consistency', Boolean(trace) && consistencyFailures.length === 0,
      !trace ? 'Cannot check intermediate/final consistency because the agent trace is missing or invalid.'
        : consistencyFailures.length ? consistencyFailures.join('; ')
          : 'Intermediate evidence references and conclusions are consistent with the final answer.'));
  }
  return graders;
}

/** Diagnostic only: describe a keyword that appears solely inside a longer word (e.g. "day" in "days"). */
function embeddedInWord(text, phrase) {
  const haystack = normalize(text);
  const needle = normalize(phrase);
  if (!needle) return null;
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const token = /[\p{L}\p{N}_]+/gu;
  for (const match of haystack.matchAll(token)) {
    if (match.index <= index && index < match.index + match[0].length && match[0] !== needle) {
      return `"${needle}" appears only inside "${match[0]}"`;
    }
  }
  return null;
}

function containsPhrase(text, phrase) {
  const haystack = normalize(text);
  const needle = normalize(phrase);
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : '';
    const afterIndex = index + needle.length;
    const after = afterIndex < haystack.length ? haystack[afterIndex] : '';
    const isWordChar = (character) => character !== '' && /[\p{L}\p{N}_]/u.test(character);
    // A boundary is only meaningful on an edge of the keyword that is itself a
    // word character. "cat" must not match inside "concatenate", but a keyword
    // such as "@" or "$" has non-word edges and must be found inside
    // "support@example.com" or "pay$5".
    const startNeedsBoundary = isWordChar(needle[0]);
    const endNeedsBoundary = isWordChar(needle[needle.length - 1]);
    if ((!startNeedsBoundary || !isWordChar(before)) && (!endNeedsBoundary || !isWordChar(after))) return true;
    from = index + 1;
  }
  return false;
}


export function gradeCase(testCase, response) {
  const content = typeof response?.content === 'string' ? response.content : '';
  const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  const toolNames = toolCalls.map((call) => call.name).filter(Boolean);
  const rules = testCase.grading_rules ?? {};
  const requiredKeywords = rules.requiredKeywords ?? testCase.required_keywords ?? [];
  const forbiddenKeywords = rules.forbiddenKeywords ?? testCase.forbidden_keywords ?? [];
  const graders = [];

  graders.push(makeCheck(
    'non_empty_output', content.trim().length > 0 || toolCalls.length > 0,
    content.trim().length > 0 || toolCalls.length > 0 ? 'Output contains text or proposed tool calls.' : 'The model returned neither text nor tool calls.'
  ));

  if (requiredKeywords.length) {
    const missing = requiredKeywords.filter((keyword) => !containsPhrase(content, keyword));
    const hints = missing.map((keyword) => embeddedInWord(content, keyword)).filter(Boolean);
    graders.push(makeCheck('required_keywords', missing.length === 0,
      missing.length
        ? `Missing required keywords: ${missing.join(', ')}${hints.length ? `. Keywords match whole words only: ${hints.join('; ')}. Use the exact word or a phrase such as the number itself.` : ''}`
        : 'All required keywords were present.'));
  }

  if (forbiddenKeywords.length) {
    const found = forbiddenKeywords.filter((keyword) => containsPhrase(content, keyword));
    graders.push(makeCheck('forbidden_keywords', found.length === 0,
      found.length ? `Found forbidden keywords: ${found.join(', ')}` : 'No forbidden keywords were present.'));
  }

  if (rules.exactMatch === true && testCase.expected_output !== null && testCase.expected_output !== undefined) {
    const expected = typeof testCase.expected_output === 'object' && testCase.expected_output !== null
      ? (testCase.expected_output.content ?? testCase.expected_output)
      : testCase.expected_output;
    const normalizedContent = normalize(content);
    const normalizedExpected = normalize(expected);
    const semanticEquivalents = Array.isArray(rules.semanticEquivalents) ? rules.semanticEquivalents : [];
    const matchedEquivalent = semanticEquivalents.find((variant) => normalize(variant) === normalizedContent);
    const exactMatched = normalizedContent === normalizedExpected;
    const passed = exactMatched || matchedEquivalent !== undefined;
    graders.push(makeCheck('exact_match', passed,
      exactMatched
        ? 'Output exactly matched after case and whitespace normalization.'
        : matchedEquivalent !== undefined
          ? 'Output matched an explicitly configured semantic equivalent; no global fuzzy matching was applied.'
          : 'Output matched neither the expected value nor any explicitly configured semantic equivalent.',
      passed ? 1 : 0,
      matchedEquivalent !== undefined && !exactMatched ? { match_type: 'semantic_equivalent' } : { match_type: 'exact' }));
  }

  if (typeof rules.expectedOutputContains === 'string') {
    const passed = content.toLocaleLowerCase().includes(rules.expectedOutputContains.toLocaleLowerCase());
    graders.push(makeCheck('expected_output_contains', passed,
      passed ? 'The expected phrase was present.' : `Expected phrase not found: ${rules.expectedOutputContains}`));
  }

  const requiredTools = testCase.required_tools ?? [];
  if (requiredTools.length) {
    const missing = requiredTools.filter((name) => !toolNames.includes(name));
    graders.push(makeCheck('required_tools', missing.length === 0,
      missing.length ? `Missing required tool calls: ${missing.join(', ')}` : 'All required tool calls were proposed.'));
  }

  const forbiddenTools = testCase.forbidden_tools ?? [];
  if (forbiddenTools.length) {
    const found = forbiddenTools.filter((name) => toolNames.includes(name));
    graders.push(makeCheck('forbidden_tools', found.length === 0,
      found.length ? `Forbidden tool calls were proposed: ${found.join(', ')}` : 'No forbidden tool calls were proposed.'));
  }

  if (rules.validJson === true) {
    let valid = false;
    try {
      JSON.parse(content);
      valid = true;
    } catch {
      valid = false;
    }
    graders.push(makeCheck('valid_json', valid, valid ? 'Output is valid JSON.' : 'Output could not be parsed as JSON.'));
  }

  if (rules.mustAbstain === true) {
    // Treat semantic uncertainty statements as abstention, not only a small
    // list of exact phrases. This covers responses such as "the information is
    // insufficient to confirm" and "the policy does not specify".
    const abstentionPatterns = [
      /\bi\s+(?:do not|don't|dont)\s+know\b/i,
      /\b(?:not enough|insufficient|inadequate)\s+(?:available\s+)?(?:information|evidence|context|details|data)\b/i,
      /\b(?:information|evidence|context|details|data)\s+(?:provided|available|supplied)?\s*(?:is|are)\s+(?:not enough|insufficient|inadequate)\b/i,
      /\binsufficient\s+to\s+(?:confirm|determine|verify|establish|answer|assess|conclude)\b/i,
      /\b(?:cannot|can't|can not|unable to|not able to)\s+(?:confirm|determine|verify|establish|answer|assess|conclude)\b/i,
      /\b(?:the\s+)?(?:provided|available|supplied)\s+(?:policy|information|context|documentation)\s+(?:does not|doesn't|do not|don't)\s+(?:specify|state|say|establish|cover|address|indicate|mention|provide)\b/i,
      // Also accept natural variants that omit "provided/supplied", e.g.
      // "The policy does not specify whether exceptions are allowed".
      /\b(?:the\s+)?policy\s+(?:does not|doesn't|do not|don't)\s+(?:specify|state|say|establish|cover|address|indicate|mention|provide)\b/i,
      /\b(?:not|never)\s+(?:specified|stated|addressed|provided|mentioned)\s+(?:in|by)\s+(?:the\s+)?(?:available|provided|supplied)?\s*(?:policy|information|context|documentation)\b/i,
      /\b(?:cannot|can't|unable to)\s+(?:tell|say)\s+(?:whether|if)\b/i,
      /\bno\s+(?:policy|information|details|evidence)\s+(?:was|were|is|are)\s+(?:provided|available|supplied)\b/i,
      // Recognize explicit absence-of-mention statements, e.g. "there is no mention of who pays return shipping".
      /\bthere\s+(?:is|are|was|were)\s+no\s+(?:explicit\s+)?(?:mention|information|detail|indication|statement|reference)\s+(?:of|about|regarding|on|as\s+to)\b/i,
      // Source-scoped absence statements. These require BOTH a reference to the
      // supplied source (context/information/policy/documentation) and an
      // absence verb, so a bare "does not include" about the real world
      // ("The plan does not include a fee") is not treated as abstention.
      /\b(?:the\s+)?(?:provided|available|supplied|given|reference)?\s*(?:context|information|policy|documentation|text|material)\s+(?:does not|doesn't|do not|don't|did not|didn't)\s+(?:include|contain|list|mention|give|offer|have|name|identify)\b/i,
      /\b(?:is|are|was|were)(?:\s+not|n['’]t)\s+(?:included|provided|listed|given|available|mentioned|specified|stated|supplied|present|found)\s+(?:in|within|from)\s+(?:the\s+|this\s+|that\s+)?(?:provided\s+|available\s+|supplied\s+|given\s+|reference\s+)?(?:context|information|policy|documentation|text|material)\b/i,
      /\bi\s+(?:do not|don't|dont)\s+have\s+[^.?!]{0,80}\b(?:in|from)\s+(?:the\s+|this\s+)?(?:provided\s+|available\s+|supplied\s+|given\s+|reference\s+)?(?:context|information|policy|documentation)\b/i,
      /\b(?:is|are|was|were)(?:\s+not|n['’]t)\s+(?:in|within)\s+(?:the\s+|this\s+)?(?:provided\s+|available\s+|supplied\s+|given\s+|reference\s+)?(?:context|information|policy|documentation|text|material)\b/i,
      /\b(?:is|are|was|were)(?:\s+not|n['’]t)\s+(?:explicitly\s+)?(?:specified|stated|mentioned|addressed|defined)\b/i,
      /\b(?:policy|context|document|text|information|material)\b[^.?!]{0,60}?\b(?:does not|doesn't|do not|don't)\s+(?:explicitly\s+)?(?:specify|state|mention|address|say|define)\b/i,
      /\b(?:was|is|were|are)\s+(?:not|never)\s+(?:provided|supplied|given)\b/i
    ];
    const passed = abstentionPatterns.some((pattern) => pattern.test(content));
    graders.push(makeCheck('abstention', passed,
      passed
        ? 'The answer explicitly indicates that the available information is insufficient or that the policy does not establish an answer.'
        : 'Expected an explicit abstention, but no recognized uncertainty or insufficient-information statement was detected.'));
  }

  graders.push(...gradeTraceRules(response, rules.traceRules));

  const score = graders.length ? graders.reduce((sum, grader) => sum + grader.score, 0) / graders.length : 1;
  return {
    passed: graders.every((grader) => grader.passed),
    score: Number(score.toFixed(4)),
    graders
  };
}
