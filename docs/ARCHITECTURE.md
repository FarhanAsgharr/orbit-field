# Orbit Field — Architecture

## The one requirement everything else serves

An inspector loses signal for three days and loses nothing. Every design
decision below follows from that.

The consequence people usually underestimate: **the device is a replica, not a
cache.** There is no "offline mode" to fall into. Every screen reads from local
SQLite, always. Sync is a background reconciliation process that the UI never
waits on. If you find yourself writing `if (isOnline)` in a screen component,
the architecture has been violated.

## Shape

```
packages/types    ← domain model + wire contracts (no logic)
packages/utils    ← pure algorithms: ULID, checklist logic, validation, scoring
packages/shared   ← RBAC, conflict merge, errors, state machine
       │
       ├── apps/backend   Express + Prisma + Postgres + Redis
       └── apps/mobile    Expo + SQLite + outbox + sync engine
```

`utils` and `shared` are shared *on purpose*, not for convenience. The checklist
logic evaluator, the validation engine, and the scoring engine all run twice —
once on the device for instant feedback, once on the server as the authority. If
those two implementations ever disagreed, an inspector would hit a submission
error they could not fix from the field. Sharing the code makes disagreement
impossible by construction.

## Identity: why ULIDs

Every primary key is a client-generatable ULID, minted on the device.

An offline device must create a record that has real identity immediately — the
inspector photographs it, attaches it, references it — long before a server sees
it. Server-generated integer keys would require an id-rewriting pass at sync
time, which means rewriting every foreign key on the device, which is where data
gets lost.

ULIDs also sort by creation time, so `ORDER BY id` has the index locality of a
sequence without the coordination.

## Sync protocol

### Cursors, not timestamps

Delta pull is "give me everything after cursor N", where N comes from a
**per-organisation monotonic sequence** allocated by `UPDATE ... RETURNING`
inside the writing transaction.

Timestamps are unusable as cursors here. A fleet of field devices has genuinely
wrong clocks — dead RTC batteries, manual time changes, timezone edits mid-shift.
Ordering replication by an untrusted clock reorders users' work. The row lock
that `UPDATE ... RETURNING` takes is what guarantees cursors are dense and
strictly increasing, so a pull can never skip a change.

### Push: intent, not state

The device queues **operations** (entity, id, field-level patch, base version),
not row snapshots. A field-level patch is what lets two devices edit disjoint
fields of the same inspection and both survive. Whole-row pushes would make every
concurrent edit a conflict.

Each operation carries a **Lamport counter** — monotonic per device — which
establishes causal order without trusting the device clock.

Push applies **one transaction per operation**, not one per batch. A device
returning from a week offline might push 300 operations; one bad operation must
not roll back the other 299, or that device never makes progress.

### Idempotency

Every operation id is recorded in a ledger on first application. A device that
pushes, loses the response, and retries gets the *original* result back rather
than creating a duplicate inspection. This is what makes the client's
"retry aggressively, never drop" policy safe.

### Conflict resolution: three-way, not last-write-wins

When a push arrives with a `baseVersion` older than the server's current version,
we do **not** reject and do **not** overwrite. We fetch the ancestor snapshot
from the change log and classify every field:

| Situation | Result |
|---|---|
| only the device changed it | take local, silently |
| only the server changed it | take server, silently |
| both changed it, same value | converged, silently |
| both changed it, differently | **real conflict — ask a human** |
| no ancestor available | treat as conflicting |

Most field "conflicts" are the first two cases — an inspector edits notes offline
while a supervisor reassigns the job in head office. Auto-merging those is what
keeps the resolution dialog rare enough that people actually read it when it
appears.

That last row matters: when the ancestor has been pruned, we cannot prove which
side moved, so we refuse to guess. Guessing is how data gets lost quietly.

Conflicts are persisted server-side, so a supervisor can resolve one from the
dashboard even if the inspector's device never comes back.

### Tombstones

Nothing is hard-deleted. A device that is offline when a row is deleted must
still learn about the deletion when it returns, and only a tombstone replicates.

## The outbox

Every user mutation writes the visible row **and** the outbox entry in the same
SQLite transaction. That single fact is what makes "no data is ever lost" true
rather than aspirational: the UI cannot display a change that is not already
durably queued, and the queue cannot lose an entry the UI has shown.

Entries leave the outbox **only** on explicit server acknowledgement. Not on
send, not on optimistic success — on ack.

Consecutive edits to the same record coalesce into one pending entry. Without
that, typing in a notes field emits one operation per keystroke and turns a 3G
sync into a multi-minute drain.

An `IN_FLIGHT` entry found at startup means the process died mid-push. We do not
know whether the server applied it — so we retry, and the idempotency ledger
makes that safe.

## Sync run

Three ordered phases: **PUSH → PULL → MEDIA**.

Push goes first so a pull can never clobber an edit the user has made but not yet
sent. During pull, a row with unsent local changes is **not** overwritten: the
server's version is stored as the merge ancestor and the user's work stays on
screen.

Media is last and is subject to the metered-network policy — a 40 MB video should
not silently consume an inspector's personal data allowance.

Each pull page lands in one transaction with its cursor, so the cursor and the
rows it covers can never disagree.

## Security posture

- **Argon2id** for passwords (memory-hard; bcrypt no longer meaningfully resists
  GPU cracking). Unknown emails still run a dummy verification so response
  timing does not enumerate the user list.
- **Refresh-token rotation with reuse detection.** Every refresh issues a
  successor and burns its parent. A reused token means theft or a cloned device;
  since we cannot tell which side is legitimate, the whole token family is
  revoked.
- **Live account checks on every request.** The token carries the role, but
  suspension and device revocation are checked against the database — a
  15-minute token must not keep a revoked device working for 15 more minutes.
- **RBAC in one place** (`packages/shared/rbac.ts`), consumed by the API
  (authoritative), the mobile app (to hide unusable controls), and the admin
  dashboard. One matrix is what prevents the classic drift where the UI offers a
  button the API rejects.
- Explicit revocations beat explicit grants beat the role baseline.
- Tokens store only SHA-256 hashes; OTPs store only HMACs.

## Deliberate trade-offs

**Template versions are immutable JSON blobs, not normalised tables.** A template
is always read and written whole, and a device pulling one needs exactly that
blob — no join fan-out over a slow link. Publishing an edit creates a new
version; an in-flight inspection keeps a hard reference to the version it started
on, so a change made in head office at noon cannot mutate the questions under an
inspector in a basement.

**Synchronous SQLite on the device.** The inspection form reads dozens of rows
per render; an async round-trip per read makes a 200-question checklist visibly
janky. expo-sqlite's sync API runs on the JSI thread, so this is safe.

**`RepeatableRead`, not `Serializable`, for sync transactions.** Cursor
allocation already serialises the only cross-row invariant, and `Serializable`
would cause spurious retries on a busy multi-device org.

**Redis is never the system of record.** Everything in it — rate-limit counters,
sync locks, challenges — is reconstructible. That is what lets the API keep
serving, degraded, when Redis is down. An inspector losing sync is worse than a
briefly weaker rate limiter.
