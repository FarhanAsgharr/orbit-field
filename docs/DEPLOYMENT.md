# Deploying Orbit Field

Everything needed to run this in production, in the order you will need it.

---

## 1. What you are deploying

| Component | Runtime | Scales |
|---|---|---|
| **API** | Node 22, Express, Prisma | Horizontally. Stateless — sessions live in Postgres, not memory. |
| **Admin console** | Static bundle behind nginx | Horizontally, or put it on a CDN. |
| **PostgreSQL 16** | — | Vertically. One writer. |
| **Redis 7** | — | Single instance is fine; see [Redis is not the system of record](#redis-is-not-the-system-of-record). |
| **Object storage** | Local disk or S3-compatible | S3 required for more than one API replica. |
| **Mobile app** | Expo / React Native | Distributed through the app stores. |

The API is the only component that must be reachable by field devices.

---

## 2. Prerequisites

- Docker 24+ and Compose v2, or a Kubernetes cluster
- PostgreSQL 16 with the `pgcrypto` and `pg_trgm` extensions available
- A TLS-terminating reverse proxy in front of the API and console
- S3-compatible object storage **if running more than one API replica**

---

## 3. Environment variables

Copy `.env.example` and fill it in. The API validates every variable at boot and
**exits rather than starting with a bad configuration** — a misconfigured secret
should stop a deploy, not surface as a 500 three hours later.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Include `?connection_limit=25`. See [connection pooling](#connection-pooling). |
| `REDIS_URL` | With password in production. |
| `JWT_ACCESS_SECRET` | 32+ chars. `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | 32+ chars, **must differ** from the access secret. |
| `OTP_SECRET` | 32+ chars, distinct again. |
| `CORS_ORIGINS` | Explicit allowlist. `*` is rejected in production. |

Generate the three secrets independently:

```bash
for name in JWT_ACCESS_SECRET JWT_REFRESH_SECRET OTP_SECRET; do
  echo "$name=$(openssl rand -base64 48)"
done
```

The API refuses to start in production if any secret still contains a value from
`.env.example`, if the access and refresh secrets match, or if `CORS_ORIGINS` is
`*`. Those are not warnings — the process exits.

### Worth tuning

| Variable | Default | Raise it when |
|---|---|---|
| `ACCESS_TOKEN_TTL_SECONDS` | 900 | Rarely. Short is the point. |
| `REFRESH_TOKEN_TTL_DAYS` | 30 | — |
| `REMEMBER_ME_TTL_DAYS` | 180 | Inspectors go offline for long stretches. |
| `SYNC_CHANGELOG_RETENTION_DAYS` | 90 | **Longer than your longest field deployment.** A device offline past this is forced into a full re-bootstrap. |
| `UPLOAD_CHUNK_SIZE_BYTES` | 5 MB | Lower it on very poor connectivity. |
| `RATE_LIMIT_MAX_REQUESTS` | 300/min | A large fleet returning from the field simultaneously. |
| `MAX_FAILED_LOGINS` | 5 | — |

---

## 4. First deployment

```bash
# 1. Configuration
cp .env.example .env.production
$EDITOR .env.production          # fill in secrets, CORS_ORIGINS, database URL

# 2. Bring up data stores
docker compose -f deployment/docker-compose.prod.yml --env-file .env.production \
  up -d postgres redis

# 3. Apply the schema
#    `migrate deploy`, never `migrate dev` — deploy applies committed migrations
#    exactly and fails on drift instead of inventing a new one.
DATABASE_URL="$DATABASE_URL" \
  npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma

# 4. Start the application
docker compose -f deployment/docker-compose.prod.yml --env-file .env.production \
  up -d api dashboard

# 5. Confirm
curl -f https://api.example.com/health/ready
```

### Creating the first administrator

There is deliberately no self-service signup and no default account. Create the
first organisation and administrator directly:

```bash
DATABASE_URL="$DATABASE_URL" npx tsx apps/backend/prisma/seed.ts
```

For a real deployment, copy `seed.ts`, replace the demo organisation and users
with your own, and **change the password** — the seeded one is published in this
repository.

---

## 5. Health endpoints

| Endpoint | Purpose | Use for |
|---|---|---|
| `/health` | Process is up | — |
| `/health/live` | Process is not wedged. Touches no dependency. | Kubernetes **liveness** |
| `/health/ready` | Database reachable | Kubernetes **readiness**, load balancer |
| `/metrics` | Prometheus exposition | Scraping |

`/health/ready` reports Redis but does **not** fail on it. Redis being down is
degraded, not unready — the API still serves, falling back to in-memory rate
limiting. An inspector losing sync is worse than a briefly weaker rate limiter.

Do not expose `/metrics` publicly. It carries no inspection data, but it does
reveal fleet size and error rates.

---

## 6. Scaling

### API

Stateless, so add replicas freely. Two constraints:

1. **Object storage must be S3** with more than one replica. The local driver
   writes chunks to a container-local disk, and a resumed upload that lands on a
   different replica will not find its earlier chunks.
2. **`TRUST_PROXY=true`** behind a load balancer, or every client appears to
   share one IP and rate limiting collapses onto a single bucket.

### Connection pooling

Postgres connections are the first ceiling you will hit. Each API replica opens
up to `connection_limit`:

```
replicas × connection_limit  <  max_connections − 20
```

With `max_connections=300`: four replicas at 25 each uses 100, leaving ample
headroom for migrations, backups, and psql. Above roughly eight replicas, put
PgBouncer in transaction mode between the API and Postgres.

### What does not scale horizontally

The **cursor allocation** in sync takes a per-organisation row lock. That is
deliberate — it is what guarantees dense, strictly increasing cursors so a delta
pull can never skip a change. It serialises writes *within one organisation*,
never across them, so a multi-tenant deployment scales fine.

### Redis is not the system of record

Everything in Redis — rate-limit counters, sync locks — is reconstructible. A
single instance is acceptable, and losing it costs a brief window of weaker rate
limiting, not data.

---

## 7. Monitoring

```bash
docker compose -f deployment/docker-compose.prod.yml \
  --profile monitoring up -d prometheus grafana
```

Alert rules ship in `deployment/prometheus/alerts.yml`. They are symptom-based:
an alert on CPU tells you nothing actionable, an alert on inspectors being
unable to sync tells you exactly what is broken.

The four worth understanding:

| Alert | Means | Do |
|---|---|---|
| `OrbitApiDown` | No scrape for 2 min | Devices cannot sync. **Nothing is lost** — work queues locally. |
| `OrbitConflictsUnresolved` | >10 for 30 min | Each blocks an inspector's queue. Resolve in the console. |
| `OrbitDevicesStale` | >5 silent for 24h | Usually powered off. Confirm before an audit. |
| `OrbitUploadBacklog` | >500 queued | Check object storage and the session sweeper. |

### Logging

Structured JSON via pino, with credentials, tokens, and password hashes redacted
at the logger rather than at each call site. Every line carries `requestId`,
which is also returned to the client in the `x-request-id` header — that is the
bridge between "a user reported an error" and the log line that explains it.

```bash
docker compose logs api | jq 'select(.requestId == "01KY9...")'
```

---

## 8. Backups

The nightly sidecar runs automatically. To run one by hand:

```bash
DATABASE_URL="$DATABASE_URL" bash deployment/scripts/backup.sh /var/backups/orbit
```

The script **verifies every archive** with `pg_restore --list` and fails if fewer
than ten tables were captured. An unverified backup is how you discover at
recovery time that six months of nightly runs produced empty files.

Set `BACKUP_S3_BUCKET` for off-host copies. A backup on the same disk as the
database protects against nothing that actually happens.

### Restore

```bash
DATABASE_URL="$DATABASE_URL" bash deployment/scripts/restore.sh /var/backups/orbit/orbit-20260724T020000Z.dump
```

Destructive, so it requires typing the target database name to confirm. After
restoring, bring the schema forward:

```bash
npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
```

### Test your restores

Quarterly, restore the most recent backup into a scratch database and run the
E2E suite against it. A backup nobody has restored is a hypothesis.

---

## 9. Disaster recovery

### What is where

| Data | Location | Recoverable from |
|---|---|---|
| Inspections, users, templates, audit log | PostgreSQL | Nightly dump |
| Photos, videos, signatures, documents | Object storage | Storage replication |
| Unsynced field work | **The devices themselves** | Sync once the API returns |

### The property that matters

Field devices hold a **durable outbox**. Every user action is written to the
visible row and the outbox in one SQLite transaction, and entries leave only on
an explicit server acknowledgement.

So a total API outage does not lose field data. Inspectors keep working, and
everything drains when service returns. Your recovery objective for the API is
about *how long inspectors cannot see each other's work*, not about data loss.

### Recovery procedure

1. Restore Postgres from the most recent verified dump.
2. Run `prisma migrate deploy`.
3. Restore object storage, or point `S3_BUCKET` at the replicated copy.
4. Start the API. **Do not reset any device.**
5. Devices reconnect and push their queued work automatically.

**Do not wipe device storage as part of recovery.** That is the one action that
turns a recoverable outage into permanent data loss.

If the restore is older than `SYNC_CHANGELOG_RETENTION_DAYS`, devices whose
cursor now exceeds the server's will receive `requiresFullResync`, discard their
cached server state, and re-bootstrap — while keeping unsent local work.

---

## 10. Security

Configured and verified:

- **Argon2id** password hashing; unknown emails still run a dummy verification so
  response timing does not enumerate the user list.
- **Refresh-token rotation with reuse detection.** A reused token means theft or
  a cloned device, so the whole token family is revoked.
- **Live account checks on every request** — a 15-minute token must not keep a
  revoked device working for 15 more minutes.
- **RBAC** with a single matrix shared by API, console, and app.
- **Rate limiting**, Redis-backed, per user and per IP, tightest on auth.
- **CSP, HSTS, `X-Frame-Options`, `Permissions-Policy`** on both API and console.
- **Origin validation** on state-changing requests, plus JSON-only enforcement so
  a cross-origin HTML form cannot reach a mutating endpoint.
- **SQL injection**: Prisma parameterises everything; the few raw queries use
  tagged templates, and sort columns come from closed allowlists.
- **Secret validation at boot**, including rejecting values from `.env.example`.

### On CSRF

This API takes bearer tokens from an `Authorization` header and sets **no auth
cookies**. Browsers do not attach that header cross-origin, so classic CSRF is
structurally impossible — there is no ambient credential to ride. A synchroniser
token would be cargo cult. What *is* defended is the cross-origin form and
`fetch` path, via origin validation and content-type enforcement.

### Your responsibilities

- Terminate TLS at the proxy; the API assumes HTTPS in production.
- Keep `/metrics` and Grafana off the public internet.
- Rotate secrets on staff departure — `POST /api/v1/devices/:id` revokes a device
  immediately.
- Set `maxDevicesPerUser` to a realistic value; the dev seed uses 25 for testing.

---

## 11. Mobile builds

```bash
cd apps/mobile
npx expo prebuild --clean
eas build --platform android --profile production
eas build --platform ios --profile production
```

Point the app at your API by setting `extra.apiUrl` in `app.json`, or override
per-profile in `eas.json`.

### Push notifications

Delivery is routed through Expo, which fronts both FCM and APNs.

1. Upload your FCM server key and APNs key to your Expo project.
2. Set `EXPO_ACCESS_TOKEN` on the API for higher rate limits.
3. Devices register their token on launch via `POST /devices/:id/push-token`.

Delivery is best-effort **by design**. A notification prompts the app to open;
the app then syncs and discovers the real state. Nothing depends on a push
arriving, which is what makes it safe to drop one.

### Background sync

Registered automatically on every cold start — not only first launch, because a
device reboot clears iOS's scheduled tasks entirely.

Both platforms make weak guarantees: iOS `BGTaskScheduler` runs when *it*
decides; Android `WorkManager` batches aggressively in Doze. The design assumes
every background run is a bonus, never a promise. The durable outbox means a run
that never fires costs latency, never data.

---

## 12. Console deployment

Static output — serve it however you like:

```bash
npm run build -w @orbit/admin-dashboard   # → apps/admin-dashboard/dist
```

Two requirements, both handled by the shipped `nginx.conf`:

1. **SPA fallback** — every unmatched path must serve `index.html`, or deep links
   404.
2. **`index.html` must never cache.** Assets are content-hashed and cache for a
   year; `index.html` must not, or a deploy leaves clients on a stale bundle
   referencing asset hashes that no longer exist.

Set `VITE_API_URL` at build time if the API is not same-origin.

---

## 13. Runbook

**"An inspector says their work is not syncing."**
1. Console → Sync monitoring. Find their device on the cursor lag rail.
2. Silent 24h+ → device is off, out of range, or revoked.
3. Behind but active → look at recent sync sessions for that device.
4. Conflicts outstanding → their queue is blocked until someone decides.

**"Uploads are stuck."**
Check `orbit_pending_uploads`, then object storage availability. Chunks resume
from wherever they stopped; nothing needs re-uploading from scratch.

**"A device was lost."**
Console → Devices → Revoke. Tokens die immediately and the device stops syncing.
Work already on it stays there — revocation is not remote wipe.

**"We need to roll back a deploy."**
Deploy the previous image tag. **Do not roll back a migration** unless you have
verified it is reversible; the schema is forward-only by design, and older API
versions tolerate additive columns.
