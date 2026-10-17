import '../src/config/env.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmProvider } from '../src/providers/llm-provider.js';
import { buildPolicyRagSubmission, makePolicyChunks, runPolicyRagCase } from './policy-rag-workflow.js';

async function main() {
const baseUrl = (process.env.EVALFORGE_URL || 'http://localhost:3000').replace(/\/$/, '');
let datasetId = process.env.EVALFORGE_DATASET_ID;
const datasetName = process.env.EVALFORGE_DATASET_NAME || 'EvalForge Policy Grounding';
const sessionCookie = process.env.EVALFORGE_SESSION_COOKIE;
const requestedModel = process.env.POLICY_RAG_MODEL || process.env.DEFAULT_GEMINI_MODEL || 'gemini-3.8-flash';
const payloadPath = join(tmpdir(), 'evalforge-policy-rag-recorded-payload.json');
const submitSavedOnly = process.argv.includes('--submit');

if (!sessionCookie) {
  console.error('Set EVALFORGE_SESSION_COOKIE. The cookie value is a secret; do not commit or print it.');
  process.exitCode = 2;
  return;
}

const headers = { cookie: `evalforge_session=${encodeURIComponent(sessionCookie)}` };
let payload;
if (submitSavedOnly) {
  try {
    payload = JSON.parse(await readFile(payloadPath, 'utf8'));
    console.log('Submitting the previously saved payload without making model calls.');
  } catch {
    console.error(`No saved payload was found at ${payloadPath}. Run without --submit first.`);
    process.exitCode = 1;
    return;
  }
} else {
if (!datasetId) {
  const datasetsResponse = await fetch(`${baseUrl}/api/datasets`, { headers });
  if (!datasetsResponse.ok) {
    console.error(`Could not list authenticated datasets (${datasetsResponse.status}). Check the API URL and session cookie.`);
    process.exitCode = 1;
    return;
  }
  const matches = (await datasetsResponse.json()).data.filter((item) => item.name === datasetName);
  if (matches.length === 0) {
    console.error(`Could not find a dataset named "${datasetName}". Set EVALFORGE_DATASET_ID to select your Policy Grounding dataset.`);
    process.exitCode = 1;
    return;
  }
  if (matches.length === 1) {
    datasetId = matches[0].id;
  } else {
    console.log(`Found ${matches.length} datasets named "${datasetName}":`);
    matches.forEach((item, index) => console.log(
      `${index + 1}. ${item.name} · ${item.test_case_count} cases · latest version ${item.latest_version ?? 'unknown'} · updated ${item.updated_at ?? 'unknown'} · ${item.id}`
    ));
    if (!stdin.isTTY) {
      console.error('Run this command in an interactive PowerShell terminal to choose a dataset, or set EVALFORGE_DATASET_ID.');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`Choose dataset 1-${matches.length}: `);
      const choice = Number(answer);
      if (!Number.isInteger(choice) || choice < 1 || choice > matches.length) {
        console.error('Invalid selection; run the command again and choose one of the listed numbers.');
        process.exitCode = 1;
        return;
      }
      datasetId = matches[choice - 1].id;
    } finally {
      rl.close();
    }
  }
}
const datasetResponse = await fetch(`${baseUrl}/api/datasets/${datasetId}`, { headers });
if (!datasetResponse.ok) {
  console.error(`Could not load the authenticated dataset (${datasetResponse.status}). Check the API URL, dataset ID, and session cookie.`);
  process.exitCode = 1;
  return;
}
const dataset = (await datasetResponse.json()).data;
const cases = dataset?.test_cases;
if (!dataset?.latest_version_id || !Array.isArray(cases) || cases.length === 0) {
  console.error('The dataset response did not include a latest version and test cases.');
  process.exitCode = 1;
  return;
}

const policyTexts = [...new Set(cases.map((testCase) => testCase.input?.context).filter((value) => typeof value === 'string' && value.trim()))];
if (!policyTexts.length) {
  console.error('No policy text was found in the dataset cases. Add policy content to each case input.context.');
  process.exitCode = 1;
  return;
}
const chunks = policyTexts.flatMap((text, index) => makePolicyChunks(text, `dataset-policy-${index + 1}`));
const provider = createLlmProvider({ provider: 'gemini', model: requestedModel });
const completed = [];

for (const [index, testCase] of cases.entries()) {
  const startedAt = Date.now();
  const result = await runPolicyRagCase({
    testCase,
    chunks,
    generate: (args) => provider.generate(args)
  });
  const duration = Date.now() - startedAt;
  completed.push({
    testCaseId: testCase.id, result, latencyMs: duration,
    inputTokens: Number.isInteger(result.usage?.inputTokens) ? result.usage.inputTokens : undefined,
    outputTokens: Number.isInteger(result.usage?.outputTokens) ? result.usage.outputTokens : undefined
  });
  console.log(`Generated ${index + 1}/${cases.length} (${testCase.name || testCase.id}) using ${result.actualModel || requestedModel}.`);
}

payload = buildPolicyRagSubmission({
  datasetVersionId: dataset.latest_version_id,
  source: 'evalforge-policy-rag-demo',
  model: requestedModel,
  cases: completed
});
await writeFile(payloadPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
console.log(`Saved generated responses locally before submission: ${payloadPath}`);
}

const submit = (body) => fetch(`${baseUrl}/api/evaluations/recorded`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
let runResponse = await submit(payload);
let runBody = await runResponse.json().catch(() => ({}));
const unsupportedModelMetadata = runResponse.status === 400
  && Array.isArray(runBody.error?.details)
  && runBody.error.details.some((issue) => issue.code === 'unrecognized_keys' && issue.keys?.includes('actual_model'));
if (unsupportedModelMetadata) {
  console.warn('The API server is running an older recorded-run schema. Retrying without per-case model metadata. Restart/rebuild the API to retain actual model labels.');
  payload = { ...payload, responses: payload.responses.map(({ actual_model, ...response }) => response) };
  await writeFile(payloadPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  runResponse = await submit(payload);
  runBody = await runResponse.json().catch(() => ({}));
}
if (!runResponse.ok) {
  console.error(`Recorded evaluation submission failed (${runResponse.status}): ${runBody.error?.message || 'Unknown API error'}`);
  if (runBody.error?.details) console.error(JSON.stringify(runBody.error.details));
  console.error(`The generated data is saved at ${payloadPath}; fix the API/session issue and rerun with --submit to avoid more Gemini calls.`);
  process.exitCode = 1;
  return;
}
console.log(`Recorded run ${runBody.data.id}: ${runBody.data.passed_cases}/${runBody.data.total_cases} passed. Open EvalForge Runs to inspect retrieved passages, citations, and graders.`);
}

main().catch((error) => {
  console.error(`Policy RAG run failed: ${error.message}`);
  process.exitCode = 1;
});
