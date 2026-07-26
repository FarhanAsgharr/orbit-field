# Disaster recovery

What to do when production is broken, in the order you should do it.

This assumes the deployment described in `docs/VERCEL.md`: Supabase Postgres,
Supabase Storage, Upstash Redis, and two Vercel projects.

## Before you need it

Run these now, not during an incident.

```sh
# Take a backup and prove it restores, in one command.
DATABASE_URL="$DIRECT_URL" node scripts/backup.mjs --out backups

# Confirm every attachment's bytes still match its recorded checksum.
node scripts/backup-storage.mjs --check
```

`backup.mjs` dumps, records a SHA-256, **restores the dump into a scratch
database and counts rows**, then drops the scratch database. That third step is
the one that matters. `pg_dump` exits 0 for a dump that restores to nothing, and
you find out during the incident. Verifying at backup time moves that discovery
to a Tuesday.

The storage check is separate because the database dump does not contain the
photographs. A database-only restore gives you inspection records whose evidence
is missing — for a compliance system, most of the value gone.

Schedule both daily. Keep the artefacts somewhere that is not the same provider
as the database.

## What each failure looks like

| Symptom | Likely cause | Go to |
|---|---|---|
| Every request 500s, `/health` fine | Database unreachable | §1 |
| `/health/ready` reports `database: down` | Supabase paused or down | §1 |
| Requests slow, rate limits behaving oddly | Redis unreachable | §2 |
| Photos 404 but inspections load | Storage credentials or bucket | §3 |
| Console loads, every API call fails CORS | `CORS_ORIGINS` drift after a redeploy | §4 |
| Data present in console, absent on phones | Change log not published | §5 |

---

## 1. Database

**First check whether it is paused rather than broken.** Free-tier Supabase
projects auto-pause after about seven days of inactivity, and a paused project
looks exactly like an outage.

```sh
curl -s -H "Authorization: Bearer $SUPABASE_TOKEN" \
  https://api.supabase.com/v1/projects/$PROJECT_REF | grep status
```

`INACTIVE` means paused. Restore it from the dashboard, or:

```sh
curl -X POST -H "Authorization: Bearer $SUPABASE_TOKEN" \
  https://api.supabase.com/v1/projects/$PROJECT_REF/restore
```

Wait for `ACTIVE_HEALTHY` — it takes a few minutes.

### Restoring from a backup

Only if the data itself is lost or corrupt. **Restoring overwrites.** Take a
dump of the current state first even if you think it is worthless; it is
evidence about what went wrong.

```sh
# 1. Verify the artefact restores before you touch production.
DATABASE_URL="$DIRECT_URL" node scripts/backup.mjs --verify-only backups/orbit-….dump

# 2. Restore. Use DIRECT_URL, port 5432 — the transaction pooler on 6543
#    cannot run the DDL this needs.
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname "$DIRECT_URL" backups/orbit-….dump

# 3. Confirm.
psql "$DIRECT_URL" -c "SELECT count(*) FROM orbit.users;"
psql "$DIRECT_URL" -c "SELECT count(*) FROM orbit.inspections;"
```

### After any restore, re-check the change log

Devices replay the change log and nothing else. A restore that rolls the
database back also rolls back `change_log`, and every device's stored cursor is
now **ahead** of the server's. Those devices will pull nothing and appear to be
working while receiving no new assignments.

```sh
psql "$DIRECT_URL" -c 'SELECT max(cursor) FROM orbit.change_log;'
psql "$DIRECT_URL" -c 'SELECT id, "syncSequence" FROM orbit.organizations;'
```

If `syncSequence` is below the highest cursor, or devices report a cursor above
it, force affected devices to re-bootstrap (More → Reset and resync in the app).
This is not optional and it is easy to miss: nothing errors.

## 2. Redis

The API degrades rather than fails: `db/redis.ts` falls back to in-memory rate
limiting when Redis is unreachable, and `/health/ready` reports `redis: down`
while still returning 200 because the service can serve.

So Redis being down is not an emergency. Rate limits become per-instance instead
of global, which on a serverless deployment means effectively weaker limits.

```sh
node -e "const R=require('ioredis');const r=new R(process.env.REDIS_URL);
r.ping().then(v=>{console.log(v);r.quit()}).catch(e=>{console.error(e.message);process.exit(1)})"
```

Replace the instance and update `REDIS_URL`. No data migration is needed —
everything in Redis is ephemeral by design.

## 3. Storage

```sh
node scripts/backup-storage.mjs --check
```

- **`unreadable (HTTP 403)` on everything** — the S3 access keys were rotated or
  revoked. Generate new ones in the Supabase dashboard under Storage → S3 access
  keys and update `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.
- **`unreadable (HTTP 404)` on some rows** — those objects are gone. The
  attachment rows still exist, so the console shows an attachment that cannot be
  opened. Restore from a mirror if you have one:
  ```sh
  node scripts/backup-storage.mjs --mirror --out backups/storage   # taken earlier
  ```
- **`checksum mismatch`** — the bytes changed after upload. Treat as corruption;
  the record's evidence is no longer trustworthy and should be flagged to
  whoever owns that inspection.

## 4. Configuration drift after a redeploy

The two most common:

- **`CORS_ORIGINS`** on the API must list the console origin exactly. A Vercel
  preview or a new custom domain changes the origin and every browser call fails
  with no server-side error.
- **CSP `connect-src`** in the root `vercel.json` must include the API origin.
  Same symptom, opposite side.

```sh
curl -s -I https://<console> | grep -i content-security-policy
curl -s -X OPTIONS https://<api>/api/v1/auth/login \
  -H "Origin: https://<console>" -H "Access-Control-Request-Method: POST" -i | grep -i allow-origin
```

## 5. Devices see nothing while the console looks fine

Almost always the change log. Rows written directly to the tables — by a
migration, a manual fix, or a restore — are invisible to `/sync/pull` unless a
corresponding `change_log` entry exists.

```sh
psql "$DIRECT_URL" -c "SELECT entity, count(*) FROM orbit.change_log GROUP BY entity;"
```

If an entity is missing, republish it. `scripts/provision-production.mjs`
contains the publishing routine and the dependency order it must follow — a
device applying the stream sequentially must never meet an inspection before the
site it points at.

## Recovery objectives

State these to your customer, and make sure the schedule matches.

| | With daily verified backups |
|---|---|
| **RPO** (data you can lose) | Up to 24 hours |
| **RTO** (time to restore) | ~30 minutes for the database; longer if storage must be re-mirrored |

If that RPO is unacceptable, move to a Supabase paid plan for point-in-time
recovery. Nothing in this document achieves sub-24-hour RPO on the free tier —
that is a plan limitation, not a procedure you can write around.

## Rehearsing

A recovery procedure nobody has executed is a document, not a capability. Once a
quarter:

1. `node scripts/backup.mjs` against production.
2. Restore into a scratch database — `--verify-only` does this without touching
   production.
3. Point a local API at the scratch database and sign in.
4. Time it. That number is your real RTO.
