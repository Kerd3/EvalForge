# EvalForge

[![EvalForge automated tests](https://github.com/Kerd3/EvalForge/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Kerd3/EvalForge/actions/workflows/test.yml)

**AI Agent Evaluation & Reliability Platform** — a backend-heavy portfolio project built with Node.js, Express, JavaScript, PostgreSQL, Redis, and BullMQ.

EvalForge runs repeatable test cases against an AI application, grades the outputs, records execution traces, and compares runs to detect regressions. It includes a deterministic mock provider, so the initial demo works without an LLM API key.

> Portfolio MVP: production-oriented foundations, not a claim of enterprise-scale production readiness. Before exposing a deployment publicly, add authentication, authorization, tenant isolation, secret management, and operational monitoring appropriate to the environment.

## Features

- Version-one datasets with JSON test cases.
- Edit datasets in the dashboard and save changes as new immutable versions, preserving the test cases referenced by existing evaluation runs.
- Asynchronous evaluation runs through Redis + BullMQ.
- Mock provider for fast, repeatable, zero-cost demonstrations.
- Optional Google Gemini and OpenAI adapters with proposed function/tool-call capture (tools are evaluated, not executed).
- Deterministic graders: non-empty output, required keywords, forbidden keywords, exact match, expected phrase, valid JSON, abstention, required tools, and forbidden tools.
- Optional LLM-as-judge per case with an explicit rubric.
- Persisted case results, grader explanations, trace events, token usage, latency, and optional configured cost estimates.
- Run comparison API with pass-rate deltas, per-case regressions, and improvements.
- Repeated-run reliability campaigns that execute 2–10 repetitions sequentially against one pinned dataset version and configuration.
- Run-to-run reliability summaries: mean pass rate, standard deviation, observed range, exploratory 95% confidence interval, per-case stability, latency, cost coverage, and actual-model routing.
- Campaign cancellation and inspectable results for every repetition.
- Background workers, bounded job retries, per-run case checkpoints, duplicate-job protection, and cancellation between cases.
- Lightweight dashboard to create datasets, launch runs, inspect grading, and compare configurations.
- Model-level reporting that separates requested and actual model IDs, shows per-model pass rates, latency, token usage, fallback cases/reasons, and provider errors with no model response.
- Docker Compose setup with PostgreSQL, Redis, API, worker, migration, and seed services.

## Quick start (recommended)

Requirements: Docker Desktop or Docker Engine with the Compose plugin.

1. Copy `.env.example` to `.env` if you want to configure a Gemini or OpenAI API key or cost values. Local Docker Compose has safe demo defaults, so the mock demo also works without a `.env` file.
2. From this folder, run:

   ```bash
   docker compose up --build
   ```

3. Open **http://localhost:3000**. The API runs database migrations, seeds the demo dataset, and starts the dashboard. The worker runs separately.
4. Select **EvalForge Demo: Support Agent Reliability**, leave provider set to **Mock provider**, and click **Start evaluation run**.
5. Open the new run to inspect each test case and grader. The seeded tests are deterministic and should pass in mock mode.
6. To assess run-to-run variability, set **Repeated runs** to a value between 2 and 10 and start a reliability campaign. Repeats use the same pinned dataset version and configuration and run sequentially.

To stop:

```bash
docker compose down
```

To stop and remove local database/Redis volumes as well:

```bash
docker compose down -v
```

**Warning:** `down -v` deletes the local EvalForge PostgreSQL and Redis data.

## Run without Docker for Node.js development

Requirements: Node.js 20+ and reachable PostgreSQL and Redis services.

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
```

Use two terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The dashboard is served at `http://localhost:3000`.

## Run a real Gemini evaluation (recommended for this portfolio project)

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). Check the project's current free-tier model availability and usage limits before running tests.
2. Copy `.env.example` to `.env` (if you have not already) and set the key locally:

   ```dotenv
   GEMINI_API_KEY=paste_your_key_here
   DEFAULT_GEMINI_MODEL=gemini-3.8-flash
   ```

   Never put this key in frontend JavaScript, commit it to Git, or paste it into chat. The `.env` file is ignored by Git.
3. Rebuild and restart the API and worker so the key is available inside both containers:

   ```bash
   docker compose up --build -d
   ```

4. In EvalForge, choose **Google Gemini API**, keep the model label as `gemini-3.8-flash` initially, select the demo dataset, and start a run. Inspect each response and grader result.

The adapter records the token counts returned by Gemini and the measured request duration. By default, the worker spaces Gemini request starts by 13 seconds (`GEMINI_MIN_REQUEST_INTERVAL_MS=13000`). This is a conservative local throttle, not a guarantee of quota availability: Google applies model- and project-specific limits. Each HTTP request has a configurable timeout (`GEMINI_REQUEST_TIMEOUT_MS=45000`). When a selected model returns HTTP 429/quota exhaustion or times out, EvalForge cools that model down and tries the next model from `GEMINI_FALLBACK_MODELS`. The default chain is `gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite`; change the comma-separated order to models available to your AI Studio project. To disable automatic fallback for a strict single-model benchmark, set `GEMINI_FALLBACK_MODELS=` in your `.env` file. A model with a long daily-quota reset is not retried in the current worker process until its cooldown expires. If every configured model is limited or times out, that test case is recorded as an explicit provider error with the earliest cooldown time rather than silently grading an empty response or leaving the worker asleep for hours. The cooldown registry and request throttle are process-local; use Redis-backed shared state if you run multiple worker processes. Set `GEMINI_MIN_REQUEST_INTERVAL_MS=0` only if you're deliberately disabling local throttling.

**Important for interpreting results:** fallback is a continuity feature, not a clean single-model benchmark. One run can contain responses from different models after a quota error or timeout. EvalForge records the requested model, actual model, and fallback reason in each result's provider metadata and execution trace. The run inspector includes model-level summaries and per-case routing details; recent runs also show observed actual model names and fallback counts. Provider errors that occur before a model responds are shown as “No model response” and are not attributed to a model's quality metrics. When comparing model quality, make sure all cases were answered by the same model; otherwise label the run as a mixed-model fallback run. Configure `GEMINI_DEFAULT_QUOTA_COOLDOWN_MS` to tune the temporary cooldown used when a 429 response has no usable retry hint, `GEMINI_DEFAULT_TIMEOUT_COOLDOWN_MS` to tune the pause after a timed-out model, and `GEMINI_REQUEST_TIMEOUT_MS` to adjust the per-request timeout. For a strict single-model benchmark, clear `GEMINI_FALLBACK_MODELS`; this keeps timeouts as errors instead of switching models.

Cost estimates use the **actual model that answered each case**, including a fallback model. Configure exact model-specific rates with `MODEL_COST_RATES_JSON` in `.env`. The registry is a JSON object grouped by provider, then exact model ID; each model entry accepts `inputPer1MUsd` and `outputPer1MUsd`, in USD per 1,000,000 tokens. Configure both rates for a complete estimate. For example, replace the placeholder model IDs and sample numbers below with rates you have verified for your account and current pricing:

   ```dotenv
   MODEL_COST_RATES_JSON='{"gemini":{"your-model-id":{"inputPer1MUsd":1.0,"outputPer1MUsd":2.0},"your-fallback-model-id":{"inputPer1MUsd":0.5,"outputPer1MUsd":1.5}}}'
   ```

   These numbers are illustrative only, not actual or recommended rates. Do not paste the example numbers without replacing them.

   Model-specific rates take priority. If an exact model rate is missing or incomplete, EvalForge uses the provider-wide `GEMINI_INPUT_COST_PER_1M_USD` / `GEMINI_OUTPUT_COST_PER_1M_USD` values only when both are configured, and labels that estimate as provider-wide rather than model-specific. If neither complete source is available, cost is shown as unavailable with an explanation; EvalForge does not guess pricing. Setting both rates to `0` is an explicit zero-rate configuration and should only be used when you have verified the applicable requests are free of charge. Cost rates are snapshotted into each result when the run happens; historical runs aren't silently recalculated when `.env` changes. The run inspector reports input/output tokens, rate source, estimated USD cost, and any pricing gaps for each actual model. These are estimates using the configured per-token input/output rate only; cached-token discounts, multimodal pricing, batch discounts, taxes, and other provider-specific billing adjustments are not automatically inferred.

Important: the Gemini free tier has model-specific limits, and Google states that free-tier content may be used to improve its products. Use synthetic/demo data—not confidential company, customer, or personal information—when using a free-tier key. Consult the [current Gemini pricing and tier information](https://ai.google.dev/gemini-api/docs/pricing) for current limits and terms.

Gemini function calls are captured for evaluation but are **not executed** by EvalForge. This keeps tests side-effect-free and lets the grader assess whether the model proposed the expected tool.

## Repeated-run reliability analysis

The run form defaults to one normal evaluation. Set **Repeated runs** to 2–10 to create a reliability campaign. EvalForge resolves the dataset version once when creating the campaign, creates a separate child run for every repetition, and processes those runs sequentially through BullMQ. This helps avoid intentionally increasing request concurrency during a repetition series. Each child run retains its own case outputs, traces, model-routing metadata, token usage, latency, and configured cost estimates.

The reliability panel reports:

- Mean pass rate across completed repetitions. Each run's pass rate is `passed / (passed + failed)`; provider errors are excluded from this denominator and reported separately.
- Run-to-run standard deviation and minimum/maximum pass-rate range.
- An exploratory 95% Student's t confidence interval for the mean run-level pass rate when at least two completed runs have scorable outcomes.
- Per-test-case pass rate and pass/fail consistency across completed repetitions.
- Average case latency, known cost subtotal and whether the full campaign cost is available, and observed actual model names.

The confidence interval is about variation in the completed run-level pass rates; it is **not a guarantee of performance on unseen cases**. With fewer than five completed repetitions it is highly uncertain. A narrow or zero interval can still be misleading if the dataset is small, unrepresentative, or mostly deterministic. Use a representative dataset and inspect errors and model routing. When quota fallback causes different actual models to answer across a campaign, don't treat that campaign as a clean single-model comparison.

Campaign HTTP API:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/evaluation-campaigns` | Create a repeated-run campaign using `dataset_id` or `dataset_version_id`, optional `provider`, `model`, and `system_prompt`, and `repeat_count` from 2 to 10. Returns HTTP 202. |
| `GET` | `/api/evaluation-campaigns/:id` | Get campaign status, child runs, reliability metrics, and per-case consistency. |
| `POST` | `/api/evaluation-campaigns/:id/cancel` | Cancel a queued or running campaign. An in-flight model request may finish before the worker stops between cases. |

Example request:

```json
{
  "dataset_id": "YOUR_DATASET_UUID",
  "provider": "mock",
  "repeat_count": 3,
  "system_prompt": "Be accurate and concise."
}
```

Use the Mock provider first to validate the workflow at zero API cost. Repeats against deterministic mock fixtures are useful for testing orchestration and graders, but they do not demonstrate real-model variability. A live-provider campaign submits the dataset repeatedly and can increase token usage and API costs roughly in proportion to the repetition count; quota errors and retries can affect actual usage.

## Run a real OpenAI evaluation

1. Add your API key to `.env`:

   ```dotenv
   OPENAI_API_KEY=your_key_here
   ```

2. Restart the API and worker:

   ```bash
   docker compose up --build -d
   ```

3. Select **OpenAI API** in the dashboard and choose a supported model. Calls may incur API charges.

Cost estimates use `MODEL_COST_RATES_JSON` for an exact OpenAI model rate when configured. Otherwise, both `OPENAI_INPUT_COST_PER_1M_USD` and `OPENAI_OUTPUT_COST_PER_1M_USD` must be set to use a provider-wide fallback estimate. Provider-wide estimates are labeled as such; if no complete rates are configured, the report gives a reason instead of inventing a cost.

## Editing datasets

Choose **Edit dataset** on a dataset card to load its latest version into the JSON editor. Update the input, reference context, tools, expected output, or grading rules, then choose **Save as version N**. Saving creates a new immutable dataset version with the edited test cases; it does not overwrite earlier versions or rewrite existing evaluation results. New evaluation runs use the latest version by default. Use **Cancel edit** to discard unsaved changes. The editor uses the same schema and validation as dataset import.

## Dataset format

Create a dataset using the dashboard's **Import dataset** section or the API:

```json
{
  "name": "Support agent smoke tests",
  "description": "A small regression suite",
  "test_cases": [
    {
      "name": "Mentions the refund deadline",
      "input": {
        "message": "What is the refund deadline?",
        "mock_response": {
          "content": "Eligible items can be returned within 30 days."
        }
      },
      "required_keywords": ["30 days"],
      "forbidden_keywords": ["guaranteed refund"],
      "grading_rules": {
        "exactMatch": false
      }
    }
  ]
}
```

Supported top-level test case fields:

- `input`: a string or JSON object. For Gemini/OpenAI, an object with a string `message` sends that message as user content. An optional string `context` is prepended as reference material. `mock_response` is a fixture used only by the Mock provider and is never sent to real models. Supply the policy facts a test needs in `context`; otherwise a real model must not be expected to know private or fictional business rules.

For an evidence-grounded Gemini test suite, import `examples/gemini-contextual-support-dataset.json` through the dashboard's Import a dataset form. The system prompt starter is `examples/GEMINI-SYSTEM-PROMPT.txt`. The context-aware sample gives each real-model case its policy facts and keeps `mock_response` isolated as a fixture. Do not expect a real model to reproduce mock fixtures; only Mock mode reads that field.
- `expected_output`: optional expected string/object. It is used by the exact-match grader when `grading_rules.exactMatch` is `true` and by the LLM judge context.
- `required_keywords`, `forbidden_keywords`: case-insensitive substring checks.
- `required_tools`, `forbidden_tools`: tool-name checks against proposed tool calls.
- `tools`: tool definitions in `{ name, description, parameters }` format. `parameters` should be a JSON Schema object.
- `grading_rules`: supported keys are `exactMatch`, `expectedOutputContains`, `validJson`, `mustAbstain`, `requiredKeywords`, `forbiddenKeywords`, `judgeEnabled`, and `judgeRubric`.

For mock-provider tests, add `input.mock_response.content` and optionally `input.mock_response.toolCalls`. This makes results deterministic and avoids API costs.

## HTTP API

All success responses use `{ "data": ... }`; errors use `{ "error": { "message": ..., "details": ... } }`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | API, PostgreSQL, and Redis health check |
| `GET` | `/api/datasets` | List datasets and latest version metadata |
| `POST` | `/api/datasets` | Create a dataset and version 1 |
| `PUT` | `/api/datasets/:id` | Save dataset edits as a new immutable version; prior versions and their evaluation results are preserved |
| `GET` | `/api/datasets/:id` | Get dataset metadata, versions, and latest test cases |
| `GET` | `/api/evaluations` | List recent evaluation runs; optional `?limit=1..100` |
| `POST` | `/api/evaluations` | Queue an evaluation; returns HTTP 202 |
| `GET` | `/api/evaluations/:id` | Get run summary, per-case results, and audit events |
| `POST` | `/api/evaluations/:id/cancel` | Cancel a queued/running run between case executions |
| `POST` | `/api/evaluations/compare` | Compare two runs with `baseline_run_id` and `candidate_run_id` |

The `GET /api/evaluations/:id` response includes `model_report`: requested model, observed actual model names, whether the run used more than one actual model, fallback counts/reasons, per-model pass/fail/error counts, average latency, input/output token totals, optional estimated cost, and cases without a model response. The run list also returns `actual_model_names`, `model_response_cases`, `fallback_cases`, and `provider_error_cases` so recent-run labels do not imply that the requested model answered every case.

Example:

```bash
curl -X POST http://localhost:3000/api/evaluations \
  -H 'Content-Type: application/json' \
  -d '{"dataset_id":"YOUR_DATASET_UUID","provider":"mock","system_prompt":"Be accurate and concise."}'
```

## Development commands

```bash
npm run dev          # Start API with Node watch mode
npm run worker       # Start BullMQ worker
npm run db:migrate   # Apply the initial SQL migration
npm run db:seed      # Seed demo dataset if it is missing
npm test             # Run unit and API-route tests
```

## Architecture

```text
Browser dashboard
       │
       ▼
Express API ────── PostgreSQL
       │                ▲
       ▼                │
 Redis / BullMQ ─── Evaluation worker
                         │
                         ▼
                    LLM adapter
                         │
                         ▼
                 Grading + trace data
```

Important design choices:

- **The API does not wait for an entire run.** It creates run and result rows, enqueues a job, and returns a run ID.
- **Evaluation state is durable.** Test inputs, run metadata, results, traces, and audit events live in PostgreSQL.
- **Results are idempotent per case/run.** The database enforces a unique `(run_id, test_case_id)` pair; completed cases are skipped if a queue job is retried.
- **A run is not the same as a passing run.** `completed` means the evaluation finished processing its cases; inspect pass/fail/error counts to judge quality.
- **Deterministic graders are preferred when possible.** The optional LLM judge supplements rule-based checks, but its score is itself fallible and should be calibrated against labeled examples.

## Known MVP limitations

- Dataset versions are immutable after creation; the current API creates a new dataset for new content rather than supporting version append/edit endpoints.
- Authentication, team accounts, tenant isolation, and per-user permissions are not implemented.
- The mock provider is a testing fixture, not an actual AI model.
- Cost estimates use configurable exact model rates when available, transparently fall back to explicitly labeled provider-wide rates, and explain when pricing is unavailable.
- LLM-as-judge results can vary and should not be treated as ground truth.
- Concurrency is currently at the worker-job level; cases within a run are processed sequentially.
- Cancellation is observed between test cases, not necessarily during an in-flight model request.
- The OpenAI adapter uses Chat Completions, while the Gemini adapter uses the Gemini `generateContent` REST endpoint. Provider API shapes and model availability can change; check the current provider docs and your account limits before relying on a model setting.

## Suggested next steps

1. Add authentication and run ownership before any public deployment.
2. Add dataset version creation and a migration workflow.
3. Add retrieval/agent trace ingestion so evaluation can grade intermediate steps.
4. Add paired statistical tests for baseline-versus-candidate comparisons, beyond the current exploratory run-level confidence interval.
5. Add representative, versioned golden datasets for each live provider and calibrate graders against labeled examples.


## Automated regression testing

Run `npm install`, then `npm test` for the complete unit, API integration, and regression suite. Run `npm run test:regression` to focus on critical behavior: context-aware abstention, required/forbidden tool grading, quota-driven Gemini fallback attribution, zero/missing pricing handling, and model-level cost aggregation.

A GitHub Actions workflow at `.github/workflows/test.yml` runs the complete suite and the dedicated regression suite on pushes and pull requests. Repeated-run analysis is covered by dedicated unit tests for variance, confidence intervals, per-case consistency, cost gaps, and model routing. It uses deterministic fixtures and does not require live Gemini/OpenAI credentials or a running database. See [REGRESSION-TESTING.md](./REGRESSION-TESTING.md) for scope and limitations.
