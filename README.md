# Orbit Field

Offline-first enterprise inspection platform.

An inspector loses signal for three days and loses nothing. Every design decision
in this repository follows from that one requirement — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning.

## Status

Feature-complete against the specification and runtime-verified against a live
PostgreSQL. 369 assertions pass; no placeholders or TODO markers remain in
application code (CI enforces this).

Two honest caveats, stated plainly:

- **The admin console has never been looked at in a browser.** It is
  build-verified, contract-verified against the live API, and covered by 26 DOM
  tests — but jsdom has no layout engine, so nothing here proves a column is
  the right width. Give it ten minutes of human eyes before you rely on it.
- **Push delivery is verified up to the Expo API boundary**, not onto a physical
  handset. Registration, preferences, quiet hours, and inbox persistence are
  tested end to end; actual APNs/FCM delivery needs a real device and your own
  credentials.

## Quick start

```bash
# 1. Infrastructure (Postgres, Redis, MinIO)
cp .env.example .env
# generate three distinct secrets:
#   openssl rand -base64 48
docker compose -f deployment/docker-compose.yml up -d postgres redis minio minio-init

# 2. Dependencies and shared packages
npm install
npm run build:packages

# 3. Database
npx prisma migrate dev --schema apps/backend/prisma/schema.prisma

# 4. API
npm run dev:backend        # http://localhost:4000/health
```

## Verify

```bash
npm test                   # 47 unit tests
npm run typecheck          # all packages, backend, mobile — clean

# Runtime verification against a live database
docker run -d --name orbit-pg -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit_dev_password \
  -e POSTGRES_DB=orbit_field -p 55432:5432 postgres:16-alpine
docker run -d --name orbit-redis -p 56379:6379 redis:7-alpine
npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
npx tsx apps/backend/prisma/seed.ts
npx tsx apps/backend/src/server.ts &
node scripts/e2e-sync.mjs   # 37 assertions — sync protocol, conflicts, idempotency
node scripts/e2e-api.mjs    # 57 assertions — devices, inspections, chunked uploads
node scripts/e2e-admin.mjs  # 64 assertions — templates, users, reference data, analytics
node scripts/e2e-dashboard-contract.mjs  # 53 assertions — dashboard ↔ API response shapes
node scripts/e2e-reports.mjs   # 49 assertions — PDF/CSV/Excel bytes, notifications, metrics

# Admin dashboard
npm run build -w @orbit/admin-dashboard
npm run dev -w @orbit/admin-dashboard   # http://localhost:5180
```

**369 assertions total** (109 unit + 260 end-to-end against a live database).

Seeded login: `inspector@northwind.test` / `OrbitField2026!`

> **These are demo credentials, published deliberately.** The seed refuses to run
> against `NODE_ENV=production`. For a real deployment, edit the users in
> `apps/backend/prisma/seed.ts` and set your own password before running it.

## Build state

| Area | State |
|---|---|
| Domain model & wire contracts (`packages/types`) | **Complete** — compiles clean |
| Checklist logic evaluator | **Complete** — 28 tests |
| Validation engine | **Complete** — shared device/server |
| Scoring engine | **Complete** — weights, N/A, critical failures |
| Conflict three-way merge (`packages/shared`) | **Complete** — 19 tests |
| RBAC matrix + record-level checks | **Complete** |
| Inspection state machine | **Complete** |
| Postgres schema (Prisma, 20 models) | **Complete** |
| Backend: config, logging, db, redis | **Complete** |
| Backend: auth (login, refresh rotation, OTP, reset, lockout) | **Complete** |
| Backend: sync push/pull/conflict-resolve | **Complete** |
| Backend: middleware (authz, errors, rate limit, validation) | **Complete** |
| Mobile: SQLite schema + migrations | **Complete** |
| Mobile: outbox | **Complete** |
| Mobile: sync engine (push/pull/apply) | **Complete** |
| Mobile: Expo app config, builds, typechecks | **Complete** |
| Mobile: repositories (inspection/response/attachment/template) | **Complete** |
| Mobile: API client (token refresh dedupe, typed errors) | **Complete** |
| Mobile: resumable chunked uploader | **Complete** |
| Mobile: session store (offline-first cold start) | **Complete** |
| Mobile: design system + UI primitives | **Complete** |
| Mobile: navigation shell, login, dashboard, list, sync, settings | **Complete** |
| Mobile: conflict resolution screen | **Complete** |
| Deployment: compose, Dockerfile, env | **Complete** |
| — | — |
| Mobile: dynamic form renderer (all field types) | **Complete** |
| Mobile: camera / photo pipeline (compress, hash, GPS) | **Complete** |
| Mobile: GPS capture (best-fix sampling, geofence, mock rejection) | **Complete** |
| Mobile: signature capture (vector strokes) | **Complete** |
| Mobile: new-inspection + template picker | **Complete** |
| Mobile: account screens (password, devices) | **Complete** |
| Mobile: offline PDF report engine | **Complete** |
| Prisma migration + seed | **Complete — applied to a live database** |
| E2E sync verification (37 assertions) | **Complete — passing** |
| — | — |
| Backend: devices API (list/rename/revoke/sessions/push-token) | **Complete — verified** |
| Backend: inspections API (search/detail/history/duplicate/archive/review/bulk) | **Complete — verified** |
| Backend: chunked upload server (resume, dedupe, checksum, download) | **Complete — verified** |
| Backend: change-log helper for non-sync writers | **Complete — verified** |
| — | — |
| Backend: templates API (CRUD, versioning, publish, clone, import/export) | **Complete — verified** |
| Backend: checklist definition validator (dangling refs, cycles) | **Complete — 25 tests** |
| Backend: users API + privilege-escalation defences | **Complete — verified** |
| Backend: reference data (clients, projects, sites, assets) | **Complete — verified** |
| Backend: analytics (summary, trend, inspectors, sites, projects, heatmap, CSV) | **Complete — verified** |
| Backend: audit logs, sync health, org settings | **Complete — verified** |
| Background sync registration (reboot survival, WorkManager/BGTaskScheduler) | **Complete** |
| Reports API (PDF / CSV / Excel, batch, summary, history) | **Complete — verified** |
| Excel engine (frozen headers, auto-filters, SUBTOTAL, typed dates) | **Complete — verified** |
| Push notifications (Expo → FCM + APNs, preferences, quiet hours) | **Complete — verified** |
| Mobile capture: barcode/QR, audio, file, document picker | **Complete** |
| Prometheus metrics, alert rules, structured request logging | **Complete — verified** |
| Backups: verified dumps, restore, storage cleanup | **Complete — verified** |
| Security hardening: origin guard, CSP/HSTS, secret validation | **Complete — verified** |
| CI/CD: GitHub Actions, multi-stage Docker, release pipeline | **Complete** |
| Deployment documentation | **Complete** |


Every phase of the original specification is implemented. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for operating it.

## Layout

```
packages/types    domain model + wire contracts (no logic)
packages/utils    pure algorithms — ULID, checklist logic, validation, scoring
packages/shared   RBAC, conflict merge, error taxonomy, state machine
apps/backend      Express + Prisma + Postgres + Redis
apps/mobile       Expo + SQLite + outbox + sync engine
apps/admin-dashboard  Vite + React operations console
deployment        compose, Dockerfile, env template
docs              architecture
```

## The parts worth reading first

- [`packages/shared/src/conflict.ts`](packages/shared/src/conflict.ts) — the
  three-way merge. The rule it enforces is that no edit is ever silently
  discarded.
- [`apps/backend/src/modules/sync/sync.service.ts`](apps/backend/src/modules/sync/sync.service.ts)
  — push/pull, idempotency, cursor allocation.
- [`apps/mobile/src/sync/outbox.ts`](apps/mobile/src/sync/outbox.ts) — why "no
  data loss" is structural rather than aspirational.
- [`packages/utils/src/logic.ts`](packages/utils/src/logic.ts) — the conditional
  logic evaluator that runs identically on device and server.

## Licence

UNLICENSED — private.
