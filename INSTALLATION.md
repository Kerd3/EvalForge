# EvalForge v1.1 Phase 1 — Authentication and Ownership Patch

This is the first implementation phase of the agreed v1.1+ roadmap. It implements individual accounts, server-side sessions, owner-scoped dataset/run/campaign access, an upgrade migration, local auth UI, and initial tests. It does **not** implement the later quality, RAG, scalability, and cost phases yet.

## Important safeguards

- Apply this to a clean feature branch based on `main`; preserve the `v1.0.0` tag.
- Back up the PostgreSQL volume before applying migrations. Do not use `docker compose down -v`.
- The installer makes a backup of replaced files in the system temp directory and performs source-anchor checks before writing.
- The database migration leaves existing `owner_id` fields null. The first registered user can claim existing/seeded legacy rows only when the configured bootstrap secret is supplied.
- Compose now defaults registration to disabled and binds host-published ports to loopback. For first-account setup, explicitly enable registration in `.env`.
- This patch needs local testing before it should be committed or deployed. It is not a claim of production readiness.

## Apply

1. In the EvalForge repository, start from a clean tree and create a feature branch:

   ```bash
   git status
   git switch main
   git pull --ff-only
   git switch -c feat/v1.1-auth-ownership
   ```

   If you have other work in progress, commit/stash it first. Do not reset or discard it.

2. Back up your existing database before any migration. For the current Compose service names, a simple SQL dump is:

   ```bash
   docker compose exec -T postgres pg_dump -U evalforge evalforge > evalforge-before-v1.1.sql
   ```

   Confirm the file exists and is non-empty. Keep it outside Git if it contains user data.

3. Extract the ZIP into the **project root**. It should create the `evalforge-v11-auth-patch/` folder alongside `package.json`, without overwriting application files.

4. From the project root, apply the patch:

   ```bash
   node evalforge-v11-auth-patch/apply-v11-auth-ownership.mjs
   ```

   If it says an anchor changed or a target already exists, stop and review rather than forcing the installer.

5. Generate a strong one-time bootstrap secret:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Put the generated value in `.env` as `EVALFORGE_BOOTSTRAP_SECRET=...` and add `EVALFORGE_REGISTRATION_ENABLED=true` for the initial account setup. Do not commit `.env`. Keep `AUTH_COOKIE_SECURE=false` only for local HTTP development; set it to `true` behind HTTPS.

6. Check JavaScript syntax and run both suites:

   ```bash
   node --check public/app.js
   node --check src/services/auth.service.js
   node --check src/routes/auth.routes.js
   node --check src/middleware/authentication.js
   npm test
   npm run test:regression
   ```

   The authoring environment could check the bundled JavaScript syntax, but could not run the complete Vitest suite against your live checkout. Treat your local test results as the acceptance check.

7. If the tests pass, rebuild and run the database migration:

   ```bash
   docker compose up --build -d
   docker compose logs --tail=100 api
   docker compose logs --tail=100 worker
   ```

   The installer changes Compose's published host bindings to loopback (`127.0.0.1`). Keep PostgreSQL/Redis inaccessible from untrusted networks. If you're using a remote self-hosted setup, front the app with a trusted reverse proxy and configure HTTPS deliberately. EvalForge ignores forwarded client-IP headers by default; set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops only when each proxy strips or overwrites untrusted forwarding headers.

## Manual acceptance checks

1. Visit `http://localhost:3000`; the account screen should appear.
2. If legacy/seeded data exists, registration should request the bootstrap secret. Try a wrong secret first: registration must fail, and existing rows must remain unowned/unchanged. Then register using the correct secret; the first account claims prior unowned records.
3. Sign in as the first account and confirm prior datasets/runs are visible.
4. Create a second account (temporarily keep registration enabled) and sign in as it. It must not see the first account's datasets, runs, or campaigns. Create one new dataset/run/campaign under the second account, sign back in as the first, and confirm that those new resources are not visible.
5. With no session, `GET /api/datasets` and `GET /api/evaluations` should return 401. A cross-origin state-changing request with an unrelated `Origin` should return 403.
6. Sign out and confirm the same user needs to sign in again. Verify wrong passwords fail and registration can be disabled.
7. After account setup, set `EVALFORGE_REGISTRATION_ENABLED=false` and run `docker compose up -d` to disable new registrations.
8. Verify existing Evaluation Inspector, campaign reports, pagination, dataset version editing, and provider evaluations still work for the account that owns those records.

Do not commit the generated bootstrap secret, session tokens, SQL dump, `.env`, or temporary backup directory.

## Scope after Phase 1

See `docs/V1.1-IMPLEMENTATION-ROADMAP.md` for acceptance criteria for grader quality, RAG/agent-trace evaluation, scale/operations, and cost/provider accuracy. Those later phases should be implemented after the security patch is passing locally, rather than mixed into an unverified authentication change.
