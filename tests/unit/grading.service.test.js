import { describe, expect, it } from 'vitest';
import { gradeCase } from '../../src/services/grading.service.js';

describe('gradeCase', () => {
  it('passes when required keywords are present without forbidden keywords', () => {
    const result = gradeCase({
      input: 'question',
      required_keywords: ['30 days', 'delivery'],
      forbidden_keywords: ['guaranteed refund'],
      required_tools: [], forbidden_tools: [], grading_rules: {}
    }, { content: 'Eligible items can be returned within 30 DAYS of delivery.', toolCalls: [] });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when a forbidden tool is proposed', () => {
    const result = gradeCase({
      input: 'delete account', required_keywords: [], forbidden_keywords: [], required_tools: [],
      forbidden_tools: ['delete_account'], grading_rules: {}
    }, { content: 'Done.', toolCalls: [{ name: 'delete_account', arguments: {} }] });
    expect(result.passed).toBe(false);
    expect(result.graders.find((grader) => grader.name === 'forbidden_tools').passed).toBe(false);
  });

  it('checks explicit abstention language', () => {
    const testCase = { input: 'unknown', required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: { mustAbstain: true } };
    expect(gradeCase(testCase, { content: "I don't know based on the information available.", toolCalls: [] }).passed).toBe(true);
    expect(gradeCase(testCase, { content: 'The available information is insufficient to confirm whether the return is eligible.', toolCalls: [] }).passed).toBe(true);
    expect(gradeCase(testCase, { content: 'The supplied policy does not specify returns after 180 days.', toolCalls: [] }).passed).toBe(true);
    expect(gradeCase(testCase, { content: 'It is definitely allowed.', toolCalls: [] }).passed).toBe(false);
  });

  it('recognizes an explicit statement that the policy makes no mention of a detail', () => {
    const testCase = {
      input: { message: 'Who pays return shipping for a damaged item?' },
      required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [],
      grading_rules: { mustAbstain: true }
    };
    const response = {
      content: 'Based on the provided policy, there is no mention of who pays return shipping.',
      toolCalls: []
    };
    const result = gradeCase(testCase, response);
    expect(result.passed).toBe(true);
    expect(result.graders.find((grader) => grader.name === 'abstention')).toMatchObject({ passed: true, score: 1 });
  });

  it('recognizes abstention when the policy does not specify an exception', () => {
    const testCase = {
      input: { message: 'Can I return an item after 45 days?' },
      required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [],
      grading_rules: { mustAbstain: true }
    };
    const response = {
      content: 'Based on the provided policy, eligible items may be returned within 30 days of delivery. The policy does not specify whether exceptions are allowed after this stated deadline.',
      toolCalls: []
    };
    const result = gradeCase(testCase, response);
    expect(result.passed).toBe(true);
    expect(result.graders.find((grader) => grader.name === 'abstention')).toMatchObject({ passed: true, score: 1 });
  });

  it('checks exact match after case and whitespace normalization', () => {
    const result = gradeCase({
      expected_output: 'Approved successfully', required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [],
      grading_rules: { exactMatch: true }
    }, { content: '  approved   SUCCESSFULLY ', toolCalls: [] });
    expect(result.passed).toBe(true);
  });

  it('checks JSON validity', () => {
    const testCase = { required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: { validJson: true } };
    expect(gradeCase(testCase, { content: '{"ok":true}', toolCalls: [] }).passed).toBe(true);
    expect(gradeCase(testCase, { content: '{not json}', toolCalls: [] }).passed).toBe(false);
  });
});

// Phase 2 regression fixtures: do not use permissive substring matching and
// do not silently apply fuzzy matching to exact outputs.
describe('calibrated deterministic matching', () => {
  it('avoids keyword false positives from partial words', async () => {
    const result = gradeCase({
      input: 'Find the word cat.', required_keywords: ['cat'], forbidden_keywords: [],
      required_tools: [], forbidden_tools: [], grading_rules: {}
    }, { content: 'Please concatenate these strings.', toolCalls: [] });
    expect(result.passed).toBe(false);
    expect(result.graders.find((grader) => grader.name === 'required_keywords').passed).toBe(false);
  });

  it('accepts only explicitly configured semantic-equivalent exact outputs', () => {
    const testCase = {
      expected_output: 'Approved successfully', required_keywords: [], forbidden_keywords: [],
      required_tools: [], forbidden_tools: [],
      grading_rules: { exactMatch: true, semanticEquivalents: ['Your request has been approved.'] }
    };
    const equivalent = gradeCase(testCase, { content: 'Your request has been approved.', toolCalls: [] });
    expect(equivalent.passed).toBe(true);
    expect(equivalent.graders.find((grader) => grader.name === 'exact_match')).toMatchObject({
      passed: true, match_type: 'semantic_equivalent'
    });

    const unlistedVariant = gradeCase(testCase, { content: 'Looks good, approved!', toolCalls: [] });
    expect(unlistedVariant.passed).toBe(false);
    expect(unlistedVariant.graders.find((grader) => grader.name === 'exact_match').passed).toBe(false);
  });
});

describe('abstention recognition for source-scoped absence statements', () => {
  const abstainCase = { input: 'q', required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: { mustAbstain: true } };
  const grade = (content) => gradeCase(abstainCase, { content }).passed;

  it.each([
    'The provided context does not include a support email address. Please check the official website.',
    'The provided context does not contain a support email.',
    'The context does not list a support email address.',
    "I'm sorry, but the support email address is not included in the information provided.",
    "I don't have a support email address in the context I was given.",
    'The reference context does not mention a support email address.',
    "I cannot provide the support email because it isn't in the context.",
    'The support email was not provided.'
  ])('accepts a natural abstention: %s', (content) => {
    expect(grade(content)).toBe(true);
  });

  it.each([
    'You can reach support at support@example.com.',
    'Our support email is help@acme.test.',
    'The plan does not include a restocking fee.',
    'Contact support through the website.',
    ''
  ])('still rejects fabricated, confident, or empty answers: %s', (content) => {
    expect(grade(content)).toBe(false);
  });
});

describe('keyword boundaries', () => {
  const kw = (forbidden, content) => gradeCase({ input: 'q', required_keywords: [], forbidden_keywords: forbidden, required_tools: [], forbidden_tools: [], grading_rules: {} }, { content });
  it('still rejects substring matches for word keywords', () => {
    expect(kw(['cat'], 'Use concatenate here.').passed).toBe(true);
    expect(kw(['cat'], 'A cat sat.').passed).toBe(false);
  });
  it('finds keywords with non-word edges inside larger tokens', () => {
    expect(kw(['@'], 'Email support@example.com').passed).toBe(false);
    expect(kw(['$'], 'It costs $5').passed).toBe(false);
    expect(kw(['@'], 'No address given.').passed).toBe(true);
  });
});

describe('real Gemini outputs from the Policy Grounding run (2026-10-16)', () => {
  const run = (rules, content) => gradeCase({ input: 'q', required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: {}, ...rules }, { content, toolCalls: [] });
  const replacement = 'Based on the provided policy, it is not specified whether customer support will replace a damaged item within 24 hours. The policy explicitly notes that it does not specify replacement processing times.';
  const sevenDays = 'Based on the reference context, the deadline to report damage to customer support is within 7 calendar days of delivery.';

  it('accepts "it is not specified whether ... the policy does not specify" as an abstention', () => {
    expect(run({ grading_rules: { mustAbstain: true } }, replacement).passed).toBe(true);
  });

  it.each([
    'Customer support will replace it within 24 hours.',
    'Damage must be reported within 7 calendar days of delivery.',
    'You can expect a replacement tomorrow, guaranteed.'
  ])('does not treat a confident answer as abstention: %s', (content) => {
    expect(run({ grading_rules: { mustAbstain: true } }, content).passed).toBe(false);
  });

  it('keeps whole-word matching: required "day" is NOT satisfied by "days", and the message says why', () => {
    const result = run({ required_keywords: ['day'] }, sevenDays);
    expect(result.passed).toBe(false);
    expect(result.graders.find((g) => g.name === 'required_keywords').details)
      .toMatch(/"day" appears only inside "days"/);
  });

  it('passes when the dataset uses the number or the exact word instead', () => {
    expect(run({ required_keywords: ['7'] }, sevenDays).passed).toBe(true);
    expect(run({ required_keywords: ['days'] }, sevenDays).passed).toBe(true);
    expect(run({ required_keywords: ['7'] }, 'It is 17 weeks.').passed).toBe(false);
  });
});
