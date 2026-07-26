# Preview environments

Every push to a non-production branch deploys a complete, isolated copy of
Orbit Field. The point is to be able to answer "does this change work" by
using the application, against real Postgres, real Redis and real object
storage, without touching a single row of customer data.

## What is isolated, and what is not

| Resource | Production | Preview | Isolation |
|---|---|---|---|
| Postgres | `orbit` schema | `orbit_preview` schema | Same Supabase project, separate schema |
| Object storage | `orbit-attachments` | `orbit-attachments-preview` | Separate bucket, same credentials |
| Redis | Upstash, no key prefix | Upstash, `preview:` key prefix | Same database, separate keyspace |
| JWT / OTP / cron secrets | production values | independently generated | Fully separate |
| Email | live transport | `MAIL_TRANSPORT=log` | Preview cannot send mail |
| Self-service signup | disabled | disabled | Same policy both sides |

Two of those share infrastructure rather than duplicating it, and both are
deliberate rather than an oversight:

- **Postgres shares a project.** The Supabase free tier permits two active
  projects and both are in use, so a third for preview cannot be created. A
  separate schema gives separate tables, separate rows and separate migration
  state; what it does not give is separate CPU, connections or disk. A preview
  running a heavy query competes with production for the same instance. That is
  the actual cost of this arrangement, and the fix is a paid plan, not a
  configuration change.
- **Redis shares a database.** Upstash's free tier allows one. `REDIS_KEY_PREFIX`
  keeps the keyspaces apart, which is what correctness depends on — without it
  the rate limiter counts a preview request and a production request from the
  same user id as one caller, and load-testing a preview would throttle real
  field devices. The quota is still shared.

**Storage credentials are shared.** Preview uses the same S3 access key as
production, scoped to a different bucket. Supabase issues project-level S3
credentials, not per-bucket ones, so a compromised preview environment can
reach the production bucket. Treat preview secrets as production secrets.

## Secrets

Signing keys are generated independently for preview. This is verified rather
than assumed: a token minted by the preview API returns 401 from the production
API, and production credentials return 401 from the preview API. Neither
environment can mint a credential the other will accept.

## Stable URLs

| | Production | Preview |
|---|---|---|
| API | `https://orbit-field-api.vercel.app` | `https://orbit-field-api-preview.vercel.app` |
| Console | `https://orbit-field-three.vercel.app` | `https://orbit-field-preview.vercel.app` |

The preview hostnames are assigned to a git branch in the Vercel project
settings, so each push to that branch re-points them at the newest deployment.
Per-deployment URLs (`orbit-field-<hash>-…`) also work and are what a pull
request comment links to.

A stable hostname is not a convenience here. The console bakes `VITE_API_URL`
in at build time and its CSP names the hosts it may connect to, and neither can
reference a URL that does not exist until after the build. `CORS_ORIGINS` on
the preview API is `https://*.vercel.app`, which covers the per-deployment
hostnames that change on every commit.

## Access

Preview deployments sit behind Vercel Authentication. Leaving them open would
publish a working copy of the application, with its own database, to anyone who
guesses a URL.

Automation gets through with a bypass secret:

```
curl -H "x-vercel-protection-bypass: $SECRET" https://orbit-field-api-preview.vercel.app/health/ready
```

The secret is set per project under *Settings → Deployment Protection →
Protection Bypass for Automation*. Both projects use the same value so one
header serves an end-to-end run.

## Verifying a preview

Run the same suite that verifies production against it:

```
ORBIT_API_URL=https://orbit-field-api-preview.vercel.app/api/v1 \
ORBIT_ADMIN_EMAIL=preview-admin@orbitfield.com \
ORBIT_ADMIN_PASSWORD=… \
ORBIT_EXTRA_HEADERS="x-vercel-protection-bypass: $SECRET" \
node scripts/e2e-production.mjs
```

34 checks covering authentication, device enrolment, offline creation and
replay, three-way merge, conflict resolution, chunked attachment upload,
PDF/XLSX/CSV report generation, RBAC and session revocation. It creates
everything it needs and removes it afterwards, so it is safe to re-run.

## Applying a migration to preview

The preview schema is migrated independently, and does not follow production
automatically:

```
DATABASE_URL="$PREVIEW_DIRECT_URL" DIRECT_URL="$PREVIEW_DIRECT_URL" \
  npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
```

`PREVIEW_DIRECT_URL` is the production direct URL with `schema=orbit` replaced
by `schema=orbit_preview`. Run it before deploying a branch that contains a new
migration, or the preview will boot against a schema its code does not expect.

## Resetting preview data

Preview data is disposable. To empty it and re-provision:

```
psql "$PREVIEW_DIRECT_URL" -c 'DROP SCHEMA orbit_preview CASCADE; CREATE SCHEMA orbit_preview;'
DATABASE_URL="$PREVIEW_DIRECT_URL" DIRECT_URL="$PREVIEW_DIRECT_URL" \
  npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
ADMIN_EMAIL=… ADMIN_PASSWORD=… INSPECTOR_EMAIL=… INSPECTOR_PASSWORD=… \
  DATABASE_URL="$PREVIEW_DIRECT_URL" DIRECT_URL="$PREVIEW_DIRECT_URL" \
  node scripts/provision-production.mjs
```

Check the connection string before running the first command. The only
difference between wiping preview and wiping production is one word in that
URL.
