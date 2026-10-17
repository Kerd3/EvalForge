# EvalForge Phase 2 — Evaluation Quality

Phase 2 adds versioned golden responses, deterministic-grader calibration, paired run comparison, uncertainty reporting, and classified failures.

## Versioned golden responses

Each test case may include up to 20 `golden_examples`. Because test cases belong to immutable `dataset_versions`, these labeled responses are preserved with the dataset version they calibrate. Supported labels are:

- `correct`
- `incorrect`
- `ambiguous`
- `conflicting`
- `adversarial`

Each example has a `response` (`content` and optional `toolCalls`), a human-reviewed `expected_passed` boolean, and an optional `rationale`. These are human-labeled calibration observations, not model responses and not automatic changes to the grader.

Use `examples/golden-grading-dataset.v1.json` as an importable sample dataset. Import it through the existing dataset JSON import flow or `POST /api/datasets`. Editing a dataset creates a new version rather than mutating the old version.

## Explicit semantic equivalence

For `grading_rules.exactMatch`, optional `semanticEquivalents` is a list of author-approved response strings. An output is accepted only if its normalized text equals the canonical expected output or one of those explicit variants. Normalization only trims, folds case, and collapses whitespace. EvalForge does not apply unbounded fuzzy or semantic similarity matching.

Keyword checks require whole-word/whole-phrase boundaries, which avoids substring false positives such as `cat` matching inside `concatenate`. Punctuation and casing are tolerated; partial word matches are not. A boundary is enforced only on a keyword edge that is a word character, so a keyword such as `@` or `$` is found inside `support@example.com`.

`mustAbstain` recognizes a fixed set of abstention phrasings, including source-scoped absence statements ("The provided context does not include ...", "... is not included in the information provided", "I don't have ... in the context"). A bare real-world statement such as "The plan does not include a fee" is not treated as abstention, and an invented answer fails.

## Calibration API

`GET /api/datasets/:id/calibration` evaluates the latest owned dataset version's golden examples and returns. To calibrate a historical version, pass `?version_id=<dataset-version-uuid>` from the dataset's `versions` list; version lookup is scoped to the owned dataset:

- Accuracy, precision, recall, specificity, and F1 where mathematically defined.
- True-positive, true-negative, false-positive, and false-negative counts.
- Metrics by golden label and per-example grader details.
- Evaluator exceptions separately from grader misclassifications.

No golden examples produces `status: "no_calibration_data"` with null metrics and an explanation (`status` is otherwise `calibrated`, or `evaluator_errors_only`); it does not infer calibration quality from normal evaluation runs.

## Paired baseline/candidate comparison

The existing `POST /api/evaluations/compare` endpoint now reports each run's pass rate over answered cases (`passed` + `failed`), its sample size, and a 95% Wilson interval. The paired estimate includes only shared test-case IDs that have a `passed`/`failed` outcome in both runs. Provider errors, evaluator errors, pending cases, and unmatched cases are excluded from the paired estimator and are reported in data-quality counts.

The paired difference interval uses a conservative difference between Bonferroni-adjusted 97.5% Wilson bounds for improvement and regression proportions, providing at least 95% marginal-bound coverage without assuming those mutually exclusive outcomes are independent. It assumes matched case pairs are independent across case IDs. Small samples can produce wide intervals; this avoids reporting zero uncertainty just because no disagreement was observed. The report states matched sample size and assumptions. For fewer than two matched graded cases, no paired interval is returned.

Test cases are matched by ID, and each dataset version stores its own test-case IDs, so runs from different dataset versions are not expected to match. The response sets `data_quality.same_dataset_version` and a `comparability_warning` in that case. `paired_analysis.excluded_breakdown` splits excluded cases into only-in-baseline, only-in-candidate, and in-both-but-not-graded-in-both; duplicate rows are ignored deterministically and counted.

## Error categories

Evaluation result rows classify failures as:

- `provider_error`: model generation or the external provider call used by the LLM judge failed.
- `evaluator_error`: deterministic grading or result-processing code raised an exception.
- `model_failure`: the provider returned an invalid response envelope or the model produced no usable text/tool calls.

`error_stage` identifies where the failure occurred. A `model_failure` row is stored with status `failed` and counted in both run-level and per-model `model_failure_cases`.

Providers that return no token usage yield `usage: null`; the runner then records estimated cost as unavailable rather than $0. Fallback responses are attributed to, and priced by, the model that actually answered. The model report adds `fallback_summary` (headline, requested/actual models, HTTP statuses, cooldown window, per-case attempts, and the original text); legacy prose-only reasons are parsed best-effort. Older rows remain nullable and appear as unclassified legacy errors instead of being retroactively guessed.

## Database migration and verification

Run `npm run db:migrate` to apply `database/migrations/005_evaluation_quality.sql`. The migration is idempotent and adds the calibration field and error classification fields without deleting existing evaluation data. After migration, run `npm test` and `npm run test:regression`. On 2026-10-16 migrations 001-005 were applied to an empty scratch PostgreSQL 16 database and the API was exercised over HTTP with a worker; see the verification table in `docs/V1.1-IMPLEMENTATION-ROADMAP.md`.

## Verification status (2026-10-16, Windows owner environment)

| Check | Result | Evidence / remaining work |
|---|---|---|
| `npm test` | Passed: 154/154 | Full Vitest suite passed after allowing localhost networking for integration tests. |
| `npm run test:regression` | Passed: 8/8 | Both regression files passed. |
| Focused Phase 2 grader/calibration/comparison/failure/cost suite | Passed: 82/82 | Includes the real-output abstention and `day`/`days` cases, `cat`/`concatenate`, `@` in an email address, no-usage unavailable cost, fallback model accounting, comparison exclusions and version warnings. |
| `npm run db:migrate` | Passed; up to date | The configured local database already had all migrations. No rows were edited by this check. |
| `git diff --check` | Passed | No whitespace errors; Git printed only its LF-to-CRLF working-copy notices. |
| Run inspector/calibration/compare UI | Manually verified in the signed-in local browser on 2026-10-17 | Inspector displayed run metrics, per-case rows, and expanded fallback attempt details. Calibration displayed the expected no-golden-data state. Comparison displayed pass-rate intervals, cross-version comparability warning, and excluded-case counts. |
| Policy Grounding live rerun | Passed: corrected-version run graded 12/12 (100%) | Required keyword `day` was replaced with `7` in the three affected cases through a new dataset version. The run used `gemini-3.1-flash-lite` fallback for 12/12 cases because requested `gemini-3.8-flash` was in quota cooldown; interpret this as a successful fallback run, not a direct requested-model benchmark. |

The source and tests show that dataset edits insert a new `dataset_versions` record and new case rows, while evaluation runs keep their original `dataset_version_id`. The previously recorded scratch-database check also observed unchanged v1 cases, golden examples, calibration output, and run linkage after creating v2. No dataset in the owner's database was edited during this session.
