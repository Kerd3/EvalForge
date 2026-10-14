function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalize(value) {
  return asText(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function makeCheck(name, passed, details, score = passed ? 1 : 0) {
  return { name, passed, score, details };
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
    const missing = requiredKeywords.filter((keyword) => !content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
    graders.push(makeCheck('required_keywords', missing.length === 0,
      missing.length ? `Missing required keywords: ${missing.join(', ')}` : 'All required keywords were present.'));
  }

  if (forbiddenKeywords.length) {
    const found = forbiddenKeywords.filter((keyword) => content.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
    graders.push(makeCheck('forbidden_keywords', found.length === 0,
      found.length ? `Found forbidden keywords: ${found.join(', ')}` : 'No forbidden keywords were present.'));
  }

  if (rules.exactMatch === true && testCase.expected_output !== null && testCase.expected_output !== undefined) {
    const expected = typeof testCase.expected_output === 'object' && testCase.expected_output !== null
      ? (testCase.expected_output.content ?? testCase.expected_output)
      : testCase.expected_output;
    graders.push(makeCheck('exact_match', normalize(content) === normalize(expected),
      normalize(content) === normalize(expected) ? 'Output exactly matched after whitespace and case normalization.' : 'Output differed from the expected value.'));
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
      /\bthere\s+(?:is|are|was|were)\s+no\s+(?:explicit\s+)?(?:mention|information|detail|indication|statement|reference)\s+(?:of|about|regarding|on|as\s+to)\b/i
    ];
    const passed = abstentionPatterns.some((pattern) => pattern.test(content));
    graders.push(makeCheck('abstention', passed,
      passed
        ? 'The answer explicitly indicates that the available information is insufficient or that the policy does not establish an answer.'
        : 'Expected an explicit abstention, but no recognized uncertainty or insufficient-information statement was detected.'));
  }

  const score = graders.length ? graders.reduce((sum, grader) => sum + grader.score, 0) / graders.length : 1;
  return {
    passed: graders.every((grader) => grader.passed),
    score: Number(score.toFixed(4)),
    graders
  };
}
