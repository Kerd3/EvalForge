// Read-only diagnostic: explain why cases in a run did not pass.
// Usage: node scripts/diagnose-failures.mjs <run-id> [--full]
// Only SELECT statements are issued. Nothing is written or changed.
import { pool, closePool } from '../src/db/pool.js';
import { gradeCase } from '../src/services/grading.service.js';

const [runId, flag] = process.argv.slice(2);
if (!runId) { console.error('Usage: node scripts/diagnose-failures.mjs <run-id> [--full]'); process.exit(2); }
const full = flag === '--full';

const { rows } = await pool.query(
  `SELECT er.status, er.score, er.graders, er.actual_output, er.tool_calls, er.latency_ms, er.error_message,
          tc.name, tc.input, tc.expected_output, tc.required_keywords, tc.forbidden_keywords,
          tc.required_tools, tc.forbidden_tools, tc.grading_rules
     FROM evaluation_results er JOIN test_cases tc ON tc.id = er.test_case_id
    WHERE er.run_id = $1 AND er.status <> 'passed' ORDER BY tc.position_index NULLS LAST, tc.name`, [runId]);

if (!rows.length) console.log('No non-passing results for this run (or run id not found).');
for (const r of rows) {
  const output = typeof r.actual_output === 'string' ? r.actual_output : (r.actual_output?.content ?? '');
  const regrade = r.status === 'error' ? null : gradeCase(r, { content: output, toolCalls: r.tool_calls ?? [] });
  console.log('\n' + '='.repeat(78));
  console.log(`${r.name}\nstatus=${r.status} score=${r.score} latency=${r.latency_ms}ms ${r.error_message ? 'error=' + r.error_message : ''}`);
  console.log('rules:', JSON.stringify({ required: r.required_keywords, forbidden: r.forbidden_keywords, grading_rules: r.grading_rules }));
  console.log('FAILED CHECKS (as stored):');
  for (const g of (r.graders ?? []).filter((g) => !g.passed)) console.log(`  - ${g.name}: ${g.details}`);
  if (regrade) {
    const changed = regrade.passed !== (r.status === 'passed')
      || JSON.stringify(regrade.graders.map((g) => g.passed)) !== JSON.stringify((r.graders ?? []).map((g) => g.passed));
    console.log(`RE-GRADED WITH CURRENT GRADER: score=${regrade.score.toFixed?.(2) ?? regrade.score} -> ${changed ? 'DIFFERS from stored result' : 'same as stored result'}`);
  }
  console.log(`MODEL OUTPUT (${output.length} chars):\n${full ? output : output.slice(0, 700) + (output.length > 700 ? ' …[use --full]' : '')}`);
}
await closePool();
