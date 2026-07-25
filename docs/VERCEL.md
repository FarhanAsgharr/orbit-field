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
| 5 | Direct Postgres connections | Every concurrent invocation is its own client; the direct connection limit is reached quickly | Supabase transaction pooler (port 6543) for `DATABASE_URL`. Migrations need DDL and advisory locks a transaction pooler cannot provide, so `DIRECT_URL` (port 5432) was added to the Prisma datasource — but see "`DIRECT_URL` is not the direct host" below, because the obvious value for it does not work on the free tier. |
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

## Six things that fail on the first attempt

Everything below was found by deploying this for real. Each one fails in a way
that does not name its own cause, so they are recorded here rather than left to
be rediscovered.

**`DIRECT_URL` is not the direct host.** The obvious value —
`db.<ref>.supabase.co:5432` — resolves to an **AAAA record only**. Supabase
gives free-tier projects an IPv6 direct endpoint, so from any machine or CI
runner without IPv6 egress `prisma migrate deploy` simply hangs. Use the
**session-mode pooler** instead: same host as the transaction pooler,
port 5432 (`aws-0-<region>.pooler.supabase.com:5432`). It is IPv4 and, unlike
the transaction pooler on 6543, it does support the DDL and advisory locks
migrations need. Verify before trusting it:

```sh
psql "$DIRECT_URL" -c "select pg_advisory_lock(1); create table _t(x int); drop table _t;"
```

**`NODE_ENV=production` breaks the build.** Vercel applies project environment
variables to the build step as well as the runtime, and npm skips
`devDependencies` when `NODE_ENV=production` — so `tsc`, `prisma` and every
`@types/*` package vanish and the build fails on missing type declarations.
The install command therefore says `npm install --include=dev`. Removing
`NODE_ENV` instead would be wrong: the API's production security assertions
key off it.

**`vercel.json` rejects `"//"` comment keys.** The schema permits no additional
properties, at the top level or nested, so the convention used elsewhere in
this repository fails validation with `should NOT have additional property`.
Explanations for that file live here instead.

**An API-only project still needs a static output directory.** With a
`buildCommand` set, Vercel fails with `No Output Directory named "public"`, and
then with `Output Directory "public" is empty`. `scripts/vercel-api-output.mjs`
writes one file to satisfy this. It is deliberately **not** named `index.html`:
static files are matched *before* rewrites, so an index document would answer
`/` itself and shadow the `/(.*)` → `/api/index` rewrite, serving a placeholder
where the API's service pointer belongs.

**`buildCommand` is capped at 256 characters.** The real command lives in the
root `package.json` as `build:api`; `vercel.json` just calls it.

**Pin the function region.** Vercel defaults to `iad1` (Virginia). If the
database and Redis are elsewhere, every query crosses an ocean and a sync push
issues many in sequence. `"regions"` in `apps/backend/vercel.json` should name
the region hosting the data.

## Sharing a project with other schemas

Prisma honours `?schema=` in both URLs, so the platform does not need a
dedicated Supabase project. Pointing `DATABASE_URL` and `DIRECT_URL` at
`?schema=orbit` puts all 24 tables in their own namespace, leaving any existing
`public` schema untouched. `migrate deploy` creates the schema if missing.

Supabase pre-installs `pgcrypto` in the `extensions` schema; the init
migration's `CREATE EXTENSION IF NOT EXISTS` is a no-op against it.

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
`prisma/seed.ts`. That script creates accounts whose password is published in
this repository, so it must never touch a live install.

## The first administrator

`ALLOW_SELF_SERVICE_SIGNUP=false` leaves no way to create the first account
through the UI, which is the point. `scripts/provision-production.mjs` creates
one, taking its credentials from the environment so nothing it writes is
guessable from the source:

```sh
ADMIN_EMAIL=… ADMIN_PASSWORD=… INSPECTOR_EMAIL=… INSPECTOR_PASSWORD=… \
DATABASE_URL=… DIRECT_URL=… node scripts/provision-production.mjs
```

It creates an organisation, a SUPER_ADMIN, an inspector, and enough reference
data to be usable — then publishes every row to the change log. That last step
is not optional: devices replay the change log and nothing else, so rows written
without log entries produce a database that looks full in the console and
completely empty on every phone. Re-running it is a no-op.

Note that `canAssignRole` requires a strictly higher rank, so a SUPER_ADMIN
cannot create another SUPER_ADMIN through the API. Use this script.

## Accounts without outbound email

`SMTP_URL` is optional in the schema, but an installation without it cannot
deliver the password-reset OTP — and an invited user is created with no
password and is expected to set one through exactly that flow. Inviting people
on a deployment with no mail provider therefore produces accounts that can
never sign in.

`POST /users` accepts an optional `password` for this reason. Supplied, the
account is created `ACTIVE` with that password and the administrator passes it
on directly; omitted, the behaviour is unchanged and the account is `INVITED`.
The console's **Add someone** form offers both and defaults to the first.
Configure `SMTP_URL` and the email flow becomes the better choice again.
