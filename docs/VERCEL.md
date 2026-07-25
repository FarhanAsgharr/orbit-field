# Running Orbit Field on Vercel

The platform was built to run as a container: a long-lived Node process holding
a port, a Postgres pool, a Redis connection and a maintenance timer. That model
is still supported and unchanged — `deployment/Dockerfile.backend` and
`railway.json` work exactly as before.

This document covers the second deployment target: the API as Vercel Functions,
backed by Supabase Postgres, Supabase Storage and Upstash Redis, all on free
tiers.

No functionality was removed to fit. Where the platform's constraints genuinely
conflicted with the architecture, the infrastructure was replaced rather than
the behaviour. The table below is the complete list of conflicts and what each
one became.

## What was incompatible, and what it is now

| # | Component | Why it cannot run as-is | Replacement |
|---|-----------|-------------------------|-------------|
| 1 | `src/server.ts` — `app.listen`, keep-alive tuning, SIGTERM drain | A function has no port to bind and is frozen, not signalled, when it goes idle | `api/index.ts` exports the same `createApp()` as a handler. The container entry point is untouched. |
| 2 | 6-hourly `setInterval` maintenance prune | A frozen instance runs no timers, so the sweep would never fire | `api/cron/maintenance.ts` on a Vercel Cron schedule (`vercel.json`), authenticated with `CRON_SECRET` |
| 3 | `STORAGE_DRIVER=local` (chunks and attachments on disk) | The filesystem is read-only apart from `/tmp`, which is per-invocation — chunk 1 and chunk 2 can land on different instances, so assembly finds nothing | `STORAGE_DRIVER=s3` against Supabase Storage's S3 endpoint. The S3 driver already existed; `@aws-sdk/client-s3` is now a real dependency instead of an optional one. |
| 4 | 5 MB upload chunks | Base64 in JSON inflates 5 MB to ~6.8 MB; Vercel rejects bodies over 4.5 MB | `UPLOAD_CHUNK_SIZE_BYTES=3145728` (~4.1 MB on the wire). Server-driven: the client uses the `chunkSize` the session returns, so no client change. |
| 5 | Direct Postgres connections | Every concurrent invocation is its own client; the direct connection limit is reached quickly | Supabase transaction pooler (port 6543) for `DATABASE_URL`. Migrations need DDL and advisory locks a transaction pooler cannot provide, so `DIRECT_URL` (port 5432) was added to the Prisma datasource. |
| 6 | `TRUST_PROXY=false` | Requests arrive via Vercel's proxy, so every client IP would read as the proxy's and rate limiting would key all traffic to one bucket | `TRUST_PROXY=true` |
| 7 | 10s default function timeout | Report generation assembles a PDF or spreadsheet in-request; a large sync push writes many rows in one transaction | `maxDuration: 60` (the Hobby ceiling) in `vercel.json` |

Redis needed no changes. Upstash speaks the Redis protocol over TLS, so
`ioredis`, the rate-limit store and `withLock` work unmodified — and the
existing fallback still holds: if Redis is unreachable the API degrades to
in-memory rate limiting rather than refusing to serve.

## Two things that behave differently, and neither is a defect

**`/metrics` reports one instance, not the fleet.** The Prometheus counters live
in process memory. Under a container that is the whole service; under functions
each instance reports only what it served. The endpoint still works, and scrape
aggregation across instances is a Prometheus-side concern. Nothing that depends
on metrics for correctness exists.

**The maintenance sweep runs daily instead of every six hours.** Daily is the
minimum granularity on the Hobby plan. Retention is measured in days — 90 for
the change log, 30 for the idempotency ledger — so the same rows are pruned;
some of them simply sit a few hours longer first. A device's re-bootstrap
threshold is unaffected.

## One bug fixed on the way

`pruneExpiredUploads` was written for the maintenance timer and exported for it,
but was never added to the timer's callback. Abandoned upload sessions and their
orphaned chunks therefore accumulated indefinitely. The cron handler calls all
three sweeps. On object storage this is also a billing matter, not just tidiness.

## Deploying

Two Vercel projects share one repository, each with its own Root Directory:

| Project | Root Directory | Serves |
|---------|----------------|--------|
| `orbit-field` | `apps/admin-dashboard` | Operations console (static SPA) |
| `orbit-field-api` | `apps/backend` | API functions + cron |

The console reaches the API cross-origin, so two settings must agree:

- the API's `CORS_ORIGINS` must list the console's origin exactly
- the console's `VITE_API_URL` must be the API origin plus `/api/v1`
- the root `vercel.json` CSP `connect-src` must include the API origin

### Environment variables — API project

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase pooler URI, port 6543, with `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Supabase direct URI, port 5432 |
| `REDIS_URL` | Upstash `rediss://` URI |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | a *different* 48 bytes — the API refuses to start if they match |
| `OTP_SECRET` | another 48 bytes |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` | `https://<project-ref>.supabase.co/storage/v1/s3` |
| `S3_REGION` | the project's region |
| `S3_BUCKET` | `orbit-attachments` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Supabase → Storage → S3 access keys |
| `S3_FORCE_PATH_STYLE` | `true` |
| `UPLOAD_CHUNK_SIZE_BYTES` | `3145728` |
| `TRUST_PROXY` | `true` |
| `CORS_ORIGINS` | the console origin — `*` is rejected at boot in production |
| `ALLOW_SELF_SERVICE_SIGNUP` | `false` for a single-customer install |

### Environment variables — console project

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | `https://<api-project>.vercel.app/api/v1` |

### Order of operations

Migrations run from a machine that can reach `DIRECT_URL`; they are not part of
the Vercel build, because a build that migrates would race itself across
concurrent deployments.

```sh
export DATABASE_URL=<pooler URI>
export DIRECT_URL=<direct URI>

npm run build:packages
npm run db:generate -w @orbit/backend
npm run db:deploy   -w @orbit/backend    # prisma migrate deploy

vercel --prod                            # from apps/backend, then apps/admin-dashboard
```

Seeding is deliberately refused against a production database — see
`prisma/seed.ts`. Production accounts are created through the registration
endpoint or by an administrator, not by the seed script.
