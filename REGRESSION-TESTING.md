# EvalForge automated regression testing

EvalForge has a Vitest test suite for unit, API integration, and critical-path regression checks. The GitHub Actions workflow at `.github/workflows/test.yml` runs on every push and pull request; it does not require Gemini/OpenAI API keys, PostgreSQL, or Redis because the automated suite uses deterministic fixtures and mocked services.

## Run locally

From the project root:

```bash
npm install
npm test
npm run test:regression
```

- `npm test` runs all tests under `tests/` (unit, integration, and regression).
- `npm run test:regression` runs the high-value behavior checks for abstention, tool-call grading, Gemini quota fallback attribution, model-specific zero/missing cost configuration, reporting aggregation, JSON contracts, and forbidden tools.

## What is protected

1. **Grading behavior:** Context-aware abstention, required tools, forbidden tools, valid JSON, and exact output contracts.
2. **Provider resilience:** A quota-exhausted primary Gemini model should route to a fallback and record both requested and actual model names.
3. **Cost safety:** Zero cost is accepted only when explicit zero input and output rates are configured; missing rates must remain unavailable rather than silently becoming zero.
4. **Model reporting:** Fallback results are grouped under the actual responding model; provider errors with no response are not attributed to a model that never answered.
5. **API contract:** Health, dataset validation, evaluation creation, Gemini provider acceptance, and unknown-route responses are covered by integration tests.

## Important limits

These are automated software regression tests, not a live model-quality certification. They do not call paid APIs and do not prove that a hosted Gemini model will answer every prompt correctly. Keep the deterministic tests in CI, and run a small live-model evaluation separately when you intentionally change prompts, model routing, or provider integrations.
