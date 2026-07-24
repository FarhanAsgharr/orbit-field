# Getting Orbit Field onto inspectors' phones

The console at <https://orbit-field-three.vercel.app> is for supervisors and
administrators. Inspectors do their work in the mobile app, which is a different
artefact and has to be built and distributed separately.

There is no APK in this repository, and no download link, because producing one
requires an account that only you can sign in to. Everything that *can* be
prepared in advance has been: icons, `app.config.ts`, `eas.json`, the monorepo
Metro config, and a build-time guard that refuses to package an app pointing at
`localhost`. The Android JS bundle has been verified to compile (1,563 modules,
4.75 MB Hermes bytecode), so the only step left is the native build itself.

---

## Order of operations

The app is useless without a server, so deploy the backend first.

```
1. Deploy the backend  ──►  gives you  https://<something>/api/v1
2. Point the app at it ──►  eas.json → EXPO_PUBLIC_API_URL
3. Build the APK       ──►  gives you an installable file
4. Distribute + seed accounts
```

---

## 1. Deploy the backend

Follow [RAILWAY.md](./RAILWAY.md). When it finishes you will have a public URL.
The app needs it **including the `/api/v1` suffix**:

```
https://orbit-field-api.up.railway.app/api/v1
```

Confirm it is live before going further:

```bash
curl https://<your-backend>/health
# {"status":"ok","service":"orbit-backend","version":"1.0.0"}
```

Then point the console at the same server: set `VITE_API_URL` in the Vercel
project settings, and add the Vercel origin to `CORS_ORIGINS` on the backend.

---

## 2. Point the app at your backend

Edit `apps/mobile/eas.json` and replace `REPLACE-ME` in the `preview` and
`production` profiles:

```json
"preview": {
  "env": { "EXPO_PUBLIC_API_URL": "https://orbit-field-api.up.railway.app/api/v1" }
}
```

This value is frozen into the APK at build time. An installed app cannot be
re-pointed at a different server without rebuilding, which is why the config
throws rather than falling back to a default when the variable is missing.

---

## 3. Build the APK

### Option A — EAS cloud build (recommended)

Builds on Expo's machines, so no Android SDK or JDK is needed locally. A free
Expo account is enough for internal-distribution builds.

```bash
npm install -g eas-cli
eas login                       # or: eas register
cd apps/mobile
eas init                        # links the project, writes the project id
eas build --platform android --profile preview
```

The build takes roughly 10–20 minutes. It ends with a URL to a downloadable
`.apk` and a QR code that installs it directly on an Android phone. That URL is
what you send to inspectors.

The `preview` profile is deliberately `buildType: apk` rather than an app
bundle: an `.aab` cannot be installed by hand and is only useful for Play Store
submission. Use the `production` profile when you get to that.

### Option B — build locally

Only worth it if you want to avoid the cloud entirely. Requires **JDK 17** and
the **Android SDK** (neither is currently installed on this machine):

```bash
cd apps/mobile
npx expo prebuild --platform android   # generates android/
cd android && ./gradlew assembleRelease
# apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

A release APK must be signed to install on a real device. `eas credentials`
manages the keystore, or generate one with `keytool` and configure it in
`android/gradle.properties`.

---

## 4. Install it

Android blocks APKs from outside the Play Store by default. Each inspector, once
per device:

1. Open the build link in Chrome on the phone and download the `.apk`.
2. Tap the downloaded file.
3. Android offers **Settings → allow this source** — enable it for Chrome or the
   file manager, then tap Install again.

The app will ask for camera, location, and notification permissions on first
launch. Location must be granted as **Allow all the time** for the background
site-attendance stamping to work; "Only while using the app" is enough for
everything else.

---

## Trying it before you deploy anything

You can run the whole system locally and reach it from a real phone on the same
Wi-Fi, without building an APK. Inspectors install **Expo Go** from the Play
Store and scan a QR code.

```bash
# terminal 1 — database and cache
cd deployment
POSTGRES_PORT=5433 REDIS_PORT=6380 docker compose up -d postgres redis

# terminal 2 — backend
cd apps/backend
export DATABASE_URL=postgresql://orbit:orbit_dev_password@localhost:5433/orbit_field
export REDIS_URL=redis://localhost:6380
export JWT_ACCESS_SECRET=dev-access-secret-not-for-production-use-0123456789abcdef
export JWT_REFRESH_SECRET=dev-refresh-secret-not-for-production-use-abcdef0123456789
export OTP_SECRET=dev-otp-secret-not-for-production-use-9876543210fedcba
export CORS_ORIGINS=http://localhost:5173
npx prisma migrate deploy && npx tsx prisma/seed.ts
npx tsx src/server.ts

# terminal 3 — the app
cd apps/mobile
EXPO_PUBLIC_API_URL=http://192.168.31.87:4000/api/v1 npx expo start
```

Two things people get wrong here:

- **Use the machine's LAN IP, not `localhost`.** `localhost` on the phone means
  the phone. The address above is this machine's current IP; re-check it with
  `ipconfig getifaddr en0`, and note that it changes when you switch networks.
- **`--tunnel` does not tunnel the API.** It only exposes the Metro bundler, so
  the phone still has to reach port 4000 directly. Keep both on the same Wi-Fi,
  and make sure the macOS firewall is not blocking inbound connections.

Expo Go runs the JavaScript but not custom native configuration. Background
location and push notifications need a real build (Option A or B); everything
else — offline capture, camera, signatures, sync — works.

---

## Test accounts

Created by `apps/backend/prisma/seed.ts`. Every account uses the same password:

**`OrbitField2026!`**

| Email | Role | Sees |
| --- | --- | --- |
| `inspector@northwind.test` | INSPECTOR | 3 assigned inspections — **use this one on the phone** |
| `inspector2@northwind.test` | INSPECTOR | No assigned work; useful for checking scoping |
| `technician@northwind.test` | TECHNICIAN | Limited field access |
| `supervisor@northwind.test` | SUPERVISOR | Review queue, all inspections |
| `manager@northwind.test` | MANAGER | Analytics, scheduling, reports |
| `admin@northwind.test` | ADMIN | Everything, including user management |
| `viewer@northwind.test` | VIEWER | Read-only; cannot push from a device |

Signing in as `inspector@northwind.test` delivers 18 change-log entries on first
sync: the organisation, 7 users, a client, a project, 3 sites, an asset, the
EICR template version, and 3 inspections (`INS-2026-000001` through `000003`).

These accounts only exist after the seed has run against the database the app is
pointed at. Seeding a deployed backend:

```bash
DATABASE_URL=<your production url> npx tsx apps/backend/prisma/seed.ts
```

> The seed refuses to run when `NODE_ENV=production` unless you also set
> `SEED_ALLOW_PRODUCTION=1`. That guard is deliberate — this repository is
> public, so the password above is public too. For a real deployment, create
> your accounts through the console's **Create account** flow instead, and use
> the seed only for demos.

---

## Verified, and not

Verified against a live server and a clean database:

- 276 end-to-end assertions across sync, API, admin, dashboard contract, and
  reports.
- `inspector@northwind.test` authenticates and receives all 3 assigned
  inspections plus the template needed to render them.
- A project-scoped inspector does **not** receive another inspector's work.
- The Android JS bundle compiles: 1,563 modules, 4.75 MB Hermes bytecode.
- `EXPO_PUBLIC_API_URL` guards fire on a missing URL and on a `localhost` URL.

Not verified, because it cannot be done from here:

- The APK itself has never been built — no JDK, no Android SDK, no Expo account.
- The app has never been run on a physical device or emulator.
- Push notifications need FCM credentials uploaded to EAS.
