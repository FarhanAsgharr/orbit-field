# Deploying the API to Railway

Railway runs the existing `Dockerfile.backend` directly, so there is nothing
platform-specific in the application code.

## 1. Create the project

```bash
npm i -g @railway/cli
railway login
railway init          # from the repository root
```

Or from the dashboard: **New Project → Deploy from GitHub → orbit-field**.

## 2. Add the data stores

In the Railway project, add two services:

- **PostgreSQL** — Railway injects `DATABASE_URL`
- **Redis** — Railway injects `REDIS_URL`

Both are reachable on the project's private network. Nothing else is needed;
the API reads those variable names directly.

## 3. Set the secrets

Generate three distinct values and set them as service variables:

```bash
for name in JWT_ACCESS_SECRET JWT_REFRESH_SECRET OTP_SECRET; do
  railway variables --set "$name=$(openssl rand -base64 48)"
done
```

Then the rest:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `CORS_ORIGINS` | Your Vercel URL, e.g. `https://orbit-field.vercel.app` |
| `TRUST_PROXY` | `true` — Railway terminates TLS at its edge |
| `ALLOW_SELF_SERVICE_SIGNUP` | `true` to allow account creation, `false` for invite-only |

The API validates all of these at boot and **exits** rather than starting
misconfigured, so a bad value fails the deploy instead of surfacing later.

### Storage

The default `local` driver writes uploads to the container filesystem, which
Railway does not persist across deploys. For anything beyond evaluation, point
at S3-compatible storage:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=...
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

This also becomes mandatory above one replica — a resumed chunk upload that
lands on a different instance will not find its earlier chunks.

## 4. Deploy

```bash
railway up
```

Migrations run automatically from the start command. Confirm:

```bash
curl https://<your-service>.up.railway.app/health/ready
# {"status":"ready","checks":{"database":"up","redis":"up"}}
```

## 5. Create the first administrator

There is no default account. Either:

- **Register through the console** — with `ALLOW_SELF_SERVICE_SIGNUP=true`, the
  first person to sign up becomes the administrator of a new organisation.
- **Or seed with your own users** — edit `apps/backend/prisma/seed.ts`, replace
  the demo accounts and password, then:

  ```bash
  railway run --service api -- \
    sh -c 'SEED_ALLOW_PRODUCTION=1 npx tsx apps/backend/prisma/seed.ts'
  ```

  The seed refuses to run in production without that flag, because the password
  it ships with is published in this public repository.

## 6. Point the console at it

In Vercel, set `VITE_API_URL` to `https://<your-service>.up.railway.app/api/v1`
and redeploy. Then add that Vercel URL to `CORS_ORIGINS` here — the API rejects
cross-origin writes from anywhere not on the allowlist.

## Scaling notes

- **Replicas above 1 require S3 storage.** See above.
- **Connection pooling**: keep `replicas × connection_limit` below Railway's
  Postgres `max_connections` less ~20. Append `?connection_limit=15` to
  `DATABASE_URL` if you scale out.
- **Redis is not the system of record.** Losing it costs a window of weaker
  rate limiting, never data.
