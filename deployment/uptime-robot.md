# External uptime monitoring

Prometheus and Grafana tell you the API is unhealthy **when the API is able to
tell you**. They run alongside it, scrape it, and depend on the same network. If
the deployment is gone, DNS is broken, or the TLS certificate has expired, they
report nothing at all — an outage looks identical to a quiet Sunday.

External monitoring is the check that survives the thing it is watching. Uptime
Robot's free tier is sufficient; so is any equivalent.

## Monitors

Create these three. The endpoints exist and are unauthenticated by design.

### 1. Liveness — is the process running

| | |
|---|---|
| Type | HTTPS |
| URL | `https://<api>/health/live` |
| Interval | 5 minutes |
| Expect | `200`, body containing `"alive"` |

Touches no dependency. It fails only when the deployment itself is gone, which
makes it unambiguous: this alert means the service is not there.

### 2. Readiness — can it actually serve

| | |
|---|---|
| Type | HTTPS, keyword |
| URL | `https://<api>/health/ready` |
| Interval | 5 minutes |
| Keyword | `"database":"up"` — alert when **not present** |
| Expect | `200` |

Returns `503` when the database is unreachable. Note it deliberately still
reports ready when *Redis* is down, because the API degrades to in-memory rate
limiting and keeps serving — so this monitor will not fire for a Redis outage.
That is intentional; use the Prometheus `orbit_redis_up` alert for that.

### 3. Console — can anyone sign in

| | |
|---|---|
| Type | HTTPS, keyword |
| URL | `https://<console>/` |
| Interval | 5 minutes |
| Keyword | `Orbit Field` — alert when not present |

The API being healthy does not mean staff can reach it. A broken console build
or a bad rewrite leaves the API green and every human locked out.

## TLS expiry

Enable SSL monitoring on all three, with the notification threshold at **30
days**. A certificate expiring on a Saturday takes the whole system down for
mobile clients as completely as the server being off, and unlike most failures
it is entirely predictable in advance.

## What not to monitor

- **Do not point a monitor at `/`, `/metrics`, or any authenticated route.**
  `/metrics` is a scrape target and hitting it every five minutes from outside
  adds noise; authenticated routes need a credential, and a credential stored in
  a monitoring service is a credential you will forget to rotate.
- **Do not set the interval below 5 minutes.** These endpoints are on the
  serverless plan's invocation budget, and a 1-minute interval across three
  monitors is 129,600 invocations a month spent on watching.

## Alert routing

Send to somewhere a human sees out of hours. An email alert at 03:00 on a
Saturday that nobody reads until Monday is a log entry, not an alert.

Set "alert when down for" to **2 consecutive checks**. A single failed check on
a serverless platform is usually a cold start racing the timeout, and paging on
it trains people to ignore the pager.

## Verifying it works

Do this once, when you set it up. An untested monitor is an assumption.

1. Note the current status — all three green.
2. In the Vercel dashboard, pause the API project.
3. Confirm monitors 1 and 2 go red and that the alert actually reaches you, on
   the device you expect it to.
4. Resume the project and confirm recovery is also notified.

If step 3 does not reach you, the monitoring is decorative. That is worth
finding out now rather than during the first real outage.
