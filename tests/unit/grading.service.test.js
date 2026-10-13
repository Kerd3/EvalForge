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
