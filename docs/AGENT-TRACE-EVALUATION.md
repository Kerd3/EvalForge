# EvalForge Phase 3 — Agent and RAG trace evaluation

Phase 3 begins with a versioned, data-only execution trace contract and deterministic graders. EvalForge validates and evaluates recorded traces; it does not invoke tools described by a trace.

## Trace contract v1

`agentTrace` follows `evalforge.agent-trace/v1` and contains:

- `retrievalResults`: retrieved evidence records with `evidenceId`, text `content`, and optional rank, score, and source.
- `citations`: evidence IDs cited by the final answer, optionally with a quote that must occur in that evidence.
- `proposedToolCalls`: proposed tool names and JSON arguments. These are observations only.
- `executedToolResults`: recorded tool arguments and results, if the upstream agent executed them. EvalForge never replays them.
- `intermediateSteps`: recorded step IDs, content, evidence IDs, and optional conclusions.

Arrays and text fields are bounded, unknown contract versions and extra fields are rejected, and the serialized trace is limited to 100 KB. The trace belongs on a generated or golden response as `agentTrace`; EvalForge's existing top-level `trace` remains the lifecycle event list.

Example grading configuration:

```json
{
  "grading_rules": {
    "traceRules": {
      "requiredEvidenceIds": ["policy-damage-v1"],
      "validateCitations": true,
      "evidenceClaims": [
        { "claim": "within 7 calendar days", "evidenceId": "policy-damage-v1" }
      ],
      "toolCallExpectations": [
        { "name": "lookup_order", "arguments": { "orderId": "A-123" }, "argumentMatch": "exact" }
      ],
      "stepConsistency": {
        "requireValidEvidenceIds": true,
        "requireConclusionsInFinalAnswer": true
      }
    }
  }
}
```

## Deterministic checks

- `missing_retrieval_evidence` checks required evidence IDs against retrieved results.
- `citation_validity` requires every citation to reference retrieved evidence; supplied quotes must occur in that evidence.
- `evidence_support` checks each author-specified claim appears in the final answer, its expected evidence, and a citation to that evidence.
- `tool_selection_and_arguments` matches expected proposed tool calls and checks arguments by exact JSON equality or recursive subset matching.
- `intermediate_final_consistency` optionally checks that intermediate evidence IDs were retrieved and their conclusions appear in the final answer.
- `agent_trace_contract` reports missing, malformed, oversized, or unsupported trace versions.

These checks are deterministic and intentionally rule-driven. They do not claim to establish semantic entailment for arbitrary free-form claims; authors must define the evidence claims they want verified. The evaluator records but does not execute proposed calls or recorded results.

## Import the sample benchmark

Use [`examples/agent-trace-benchmark.v1.json`](../examples/agent-trace-benchmark.v1.json) in the EvalForge UI:

1. Open **Import dataset**, paste the JSON file contents, and choose **Create dataset**.
2. In **Run an evaluation**, choose **EvalForge Agent Trace Benchmark**, leave **Mock provider** selected, and start the run. The four deterministic mock responses should pass 4/4.
3. On the dataset card, choose **Calibrate goldens**. The eight labeled examples should be evaluated, with all eight matching their expected labels.

The negative examples are calibration observations; they are not the live mock outputs. No live provider calls or tools are involved.

## Submit completed traces from a real agent

EvalForge exposes an authenticated `POST /api/evaluations/recorded` endpoint. It accepts only completed responses and recorded trace data. The authenticated user must own the specified dataset version. The submission must contain exactly one response for every case in that version; duplicates, missing/extra IDs, malformed traces, and payloads over 900 KB are rejected before persistence. Successful submissions are graded and stored atomically as a completed run (`provider: recorded`); no generation queue, provider, or tools are invoked.

Example request (send the user's existing session cookie and JSON content type):

```json
{
  "dataset_version_id": "11111111-1111-4111-8111-111111111111",
  "source": "customer-support-rag",
  "model": "support-agent-v2",
  "responses": [{
    "test_case_id": "22222222-2222-4222-8222-222222222222",
    "response": {
      "content": "Report damage within 7 days.",
      "toolCalls": [],
      "agentTrace": {
        "schemaVersion": "evalforge.agent-trace/v1",
        "retrievalResults": [{ "evidenceId": "damage-policy", "content": "Report damage within 7 days." }],
        "citations": [{ "evidenceId": "damage-policy", "quote": "within 7 days" }],
        "proposedToolCalls": [], "executedToolResults": [], "intermediateSteps": []
      }
    },
    "latency_ms": 830,
    "input_tokens": 412,
    "output_tokens": 21
  }]
}
```

For caller-side conversion, import `adaptAgentEventLog` and `createRecordedEvaluationPayload` from `src/adapters/agent-trace.adapter.js` (or copy the small adapter into the agent service). The adapter maps completed events named `retrieval`/`retrieval_result`, `citation`, `tool_call_proposed`/`tool_call`, `tool_result`/`tool_call_completed`, and `intermediate_step`. Map your framework's event names to these fields explicitly. Then POST the returned payload to `/api/evaluations/recorded` using the authenticated session. The adapter only transforms data; it does not execute tools. Do not include credentials, access tokens, or unnecessary sensitive data in trace fields.

### Run the local Policy Grounding RAG example

The repository includes a small runnable Node.js workflow. It splits policy text from the selected dataset into stable sentence chunks, ranks them with local TF-IDF retrieval, passes only the top passages to the configured Gemini provider, asks for an answer with evidence-ID citations, and submits a complete recorded run. It makes one model call per test case and uses no tools or vector database. This is a real retrieval-plus-generation prototype, but the lexical retriever is intentionally simple and is not a production semantic-search system.

In PowerShell, set the dataset UUID and the signed-in EvalForge session-cookie value for this terminal session only, then run the script:

```powershell
$env:EVALFORGE_SESSION_COOKIE = '<your evalforge_session cookie value>'
npm run demo:policy-rag
```

The script finds the uniquely named **EvalForge Policy Grounding** dataset automatically. If duplicates exist, it lists them and prompts for a choice; choose the desired dataset and version. If yours has a different name, set `EVALFORGE_DATASET_ID` to its UUID. The API defaults to `http://localhost:3000`; override it with `EVALFORGE_URL` if needed. The model defaults to `DEFAULT_GEMINI_MODEL`; override it with `POLICY_RAG_MODEL`. The repository `.env` must contain a valid `GEMINI_API_KEY`. The script loads the dataset's latest version and case IDs from the authenticated API, runs every case, saves the completed payload under the operating system's temporary directory, then submits it. If submission fails, retry the saved payload with `npm run demo:policy-rag -- --submit`; this does not call Gemini again. It may take several minutes due to provider throttling and consumes provider quota. Treat the session cookie as a password: keep it out of source control, logs, and chat. The resulting run is inspectable in EvalForge's Runs view.

Minimal caller example:

```js
import { createRecordedEvaluationPayload } from './agent-trace.adapter.js';

const payload = createRecordedEvaluationPayload({
  datasetVersionId, source: 'my-rag-service', model: 'agent-v2',
  cases: finishedCases.map((item) => ({
    testCaseId: item.evalForgeCaseId,
    finalAnswer: item.answer,
    events: item.completedEvents,
    latencyMs: item.elapsedMs
  }))
});
await fetch(`${evalForgeUrl}/api/evaluations/recorded`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});
```

Keep raw payloads out of logs and retain only trace fields needed for evaluation. If async processing is added later, enqueue only validated immutable trace data; never invoke its proposed tools.

Keep raw payloads out of logs, avoid putting secrets in tool results, and retain only trace fields needed for evaluation. Existing auth, same-origin mutation checks, and rate limiting should protect the endpoint. If async processing becomes necessary, enqueue only the already-validated, immutable trace payload or a reference to a persisted payload; never invoke its proposed tools.

## Current implementation status

The first Phase 3 slice implements the contract, schema validation for dataset trace rules and golden response traces, mock-provider recorded-trace pass-through, result persistence in `actual_output.agentTrace`, and deterministic checks with fixtures for unsupported citations, invalid tool arguments, missing retrieval evidence, and intermediate/final inconsistency. Valid traces are stored; malformed traces are graded as failures and only their validation message is retained. No migration was needed because results already store JSONB output and trace data.

Verification on 2026-10-17: `npm test` passed (168/168), including the trace graders and runner persistence tests; `npm run test:regression` passed (8/8); `git diff --check` was clean. The first full-suite attempt under the default Windows sandbox was blocked by localhost `EACCES`; the full suite passed when rerun with localhost access.

Sample UI acceptance (owner-reported, 2026-10-17): **EvalForge Agent Trace Benchmark v1** completed with 4/4 mock cases passing. Golden calibration evaluated 8/8 examples with 100% accuracy, 4 true positives, 4 true negatives, zero false positives, zero false negatives, and zero evaluator errors. This confirms the sample's mock run and calibration UI flow; it does not establish general semantic grounding accuracy beyond the synthetic labeled examples.

Recorded-run API, caller adapter, and local Policy Grounding RAG example implemented on 2026-10-17. The local LLM-backed example is a runnable integration and has not been submitted against a live provider/session in this implementation pass. Remaining Phase 3 work includes live owner-isolated acceptance, deeper semantic claim/evidence analysis, UI presentation improvements, and full phase acceptance.
