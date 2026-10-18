# EvalForge operations guide

## Docker Compose

For a fresh local checkout, copy `.env.example` to `.env`, then run:

```powershell
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 api worker postgres redis
```

The dashboard, PostgreSQL and Redis host ports bind to loopback. Do not change those bindings to `0.0.0.0` for a shared deployment. Compose uses a known development database password when `POSTGRES_PASSWORD` is unset; this default is for local use only. Before exposing EvalForge to other machines, set a unique alphanumeric `POSTGRES_PASSWORD`, a strong `EVALFORGE_BOOTSTRAP_SECRET`, disable registration after account setup, and set `AUTH_COOKIE_SECURE=true` when HTTPS terminates in front of the API. Set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops; do not trust arbitrary forwarded headers. Keep `.env` out of version control and inject secrets with the deployment platform's secret manager where available.

For local-only HTTPS, set `EVALFORGE_DOMAIN=localhost` in `.env`, then start the stack with:

```powershell
docker compose --profile https -f docker-compose.yml -f docker-compose.https.yml up -d --build
docker compose --profile "*" -f docker-compose.yml -f docker-compose.https.yml ps
```

The included Caddyfile uses Caddy's internal certificate authority. Caddy's HTTP and HTTPS ports bind to `127.0.0.1`; the HTTPS profile removes the API host port mapping so browser requests reach Express only through Caddy. PostgreSQL and Redis remain loopback-bound. The profile enables secure auth cookies and configures the API to trust exactly one proxy hop from Caddy. Check `https://localhost/api/health` and verify login and secure-cookie behavior in the browser. Windows curl may report a Schannel revocation-check error for this local certificate; `curl.exe --ssl-no-revoke` is a diagnostic that skips revocation checking, while `-k` disables certificate verification and must not be treated as a trust check. This local setup does not validate a public domain, public CA certificate, DNS, or a future hosted deployment.

### Local HTTPS validation record (2026-10-18)

The merged Compose configuration parsed successfully. Before the API port override, the running Caddy, API, PostgreSQL, and Redis published ports were bound to `127.0.0.1`; the worker had no published host port. The HTTPS profile now removes the API host port mapping so only Caddy accepts host traffic and forwards it to Express. The live API container reported `TRUST_PROXY_HOPS=1` and `AUTH_COOKIE_SECURE=true`, and `src/server.js` passes the configured proxy hop count to Express. Through Caddy, `/api/health` returned 200, while unauthenticated `/api/datasets` and `/api/evaluations` returned 401. The user previously reported that Edge showed no certificate warning and that the auth cookie included `Secure`, `HttpOnly`, and `SameSite=Lax`; those browser observations were not repeated in this check.

Windows `curl.exe` with default Schannel verification failed with `CRYPT_E_NO_REVOCATION_CHECK`; `curl.exe --ssl-no-revoke` reached the health endpoint. The latter skips revocation checking, so full default curl certificate validation remains unresolved for this local internal CA. The user reported that the previously exposed Gemini key was revoked, a replacement was configured locally, and a final Gemini check was run; its result was not supplied, so this guide does not claim the provider check passed. No key value is stored here.

Authenticated operators can inspect persisted request metrics and current queue counts at `GET /api/ops/metrics`; request counters are stored in Redis and survive API process restarts. API logs are JSON lines with request IDs. Worker job completion/failure logs are JSON lines. Do not log prompts, API keys, cookies, or full provider responses.

Provider limits are shared across workers through Redis. `EVAL_CONCURRENCY` bounds concurrent queue jobs per worker; `OPENAI_MAX_CONCURRENCY` and `GEMINI_MAX_CONCURRENCY` independently bound total in-flight requests across all workers. Provider calls acquire a Redis lease that is released after the request; abandoned slots expire if a worker crashes. Redis must remain reachable for provider calls, and the limiter fails closed when Redis cannot grant a slot. Gemini cooldowns use the same Redis service.

HTTP request metrics are also stored in Redis, shared across API replicas, and retained across API restarts. Redis AOF is enabled in Compose with every-second fsync, so a host crash can still lose the most recent second of writes. Queue counts are read from BullMQ when the metrics endpoint is requested.

## Database backup

Keep backups outside the repository and protect them as sensitive data: database rows include datasets, user accounts, runs, and recorded outputs. A custom-format dump can be created without stopping the app:

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
$container = docker compose ps -q postgres
docker exec $container pg_dump -U evalforge -d evalforge -Fc -f /tmp/evalforge.dump
docker cp "${container}:/tmp/evalforge.dump" .\backups\evalforge-$(Get-Date -Format yyyyMMdd-HHmmss).dump
docker exec $container rm -f /tmp/evalforge.dump
```

The dump is consistent at PostgreSQL's transaction snapshot. Store copies encrypted and off the host, restrict access, and define retention according to the data's sensitivity. Redis contains queue state and cooldowns; PostgreSQL is the system of record. A database dump does not back up Redis jobs.

## Restore drill (isolated scratch database)

Run this drill periodically and before upgrades. It creates a separate database and does not overwrite `evalforge`:

```powershell
$container = docker compose ps -q postgres
$backup = (Resolve-Path .\backups\YOUR-BACKUP.dump).Path
docker cp $backup "${container}:/tmp/evalforge-restore-drill.dump"
docker exec $container createdb -U evalforge evalforge_restore_drill
docker exec $container pg_restore -U evalforge -d evalforge_restore_drill --no-owner --no-privileges /tmp/evalforge-restore-drill.dump
docker exec $container psql -U evalforge -d evalforge_restore_drill -c "SELECT 'datasets' AS table_name, count(*) FROM datasets UNION ALL SELECT 'runs', count(*) FROM evaluation_runs;"
docker exec $container dropdb -U evalforge evalforge_restore_drill
docker exec $container rm -f /tmp/evalforge-restore-drill.dump
```

Record the backup timestamp, restore duration, and row counts in the operations log. For a real disaster recovery, restore to a replacement PostgreSQL instance, validate the application, then switch traffic; never test destructive restore commands against the live database.

## Queue behavior and recovery

BullMQ stores pending jobs in Redis. Queue adds use deterministic IDs (`run-<UUID>` and `campaign-<UUID>`) to deduplicate repeated enqueue requests while the retained job exists. Jobs retry up to `EVAL_MAX_ATTEMPTS` with exponential backoff. Workers close gracefully on container stop, so active jobs can finish before shutdown; jobs still pending in Redis are available after restart. Per-case results are persisted, and a retry skips terminal case results. Check `/api/ops/metrics` for waiting, active, delayed, failed and completed counts, then inspect the associated run/campaign in EvalForge before retrying failed work.

## Upgrade validation

Before deployment, take a PostgreSQL backup, build the new image, start the stack, and check API/worker logs and `/api/health`. The API container applies pending SQL migrations before starting. For a v1.0 upgrade, retain the existing `evalforge_pgdata` volume and its matching database credentials; never use `docker compose down -v`. Verify representative datasets, versions, runs, results, campaigns, and auth ownership before routing users to the upgraded service.
