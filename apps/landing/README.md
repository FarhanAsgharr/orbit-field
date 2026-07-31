# Orbit Field — landing site

The front desk for the platform. It owns no data, holds no session and talks to
no API: its whole job is to put four audiences through the right door — a
customer to their company's portal, an operator to the console, an inspector to
the Android build, and an engineer to the API reference.

That is why it is a separate application. It shares nothing with the console,
the portal or the API except a set of links, so it can be a static bundle on a
CDN and can be deployed, broken or rebuilt without any of them noticing.

```
apps/landing
├── index.html            # SEO, JSON-LD, and the pre-paint theme script
├── src/
│   ├── lib/config.ts     # every external URL, read from the environment
│   ├── components/       # one file per section
│   └── styles.css        # the theme, as two blocks of CSS variables
└── public/               # icons, OG image, robots, sitemap, screenshots
```

## Running it

```bash
npm install                        # from the repository root
npm run dev -w @orbit/landing      # http://localhost:5182
npm run build -w @orbit/landing    # → apps/landing/dist
```

No environment file is needed. Every value falls back to the address the
platform is deployed at today, so an empty environment produces a working site
rather than a page of dead links.

## Configuration

Copy `.env.example` to `.env.local`, or paste the variables into Vercel. Only
names beginning `VITE_` reach the browser.

| Variable | What it points at |
| --- | --- |
| `VITE_CLIENT_PORTAL_URL` | The Client Portal origin |
| `VITE_ADMIN_DASHBOARD_URL` | The Admin Dashboard origin |
| `VITE_API_URL` | The API origin. `/docs`, `/redoc` and `/openapi.json` are derived from it |
| `VITE_GITHUB_URL` | Repository |
| `VITE_CONTACT_URL` | Anything a link can address — `mailto:`, a form, a chat |
| `VITE_APK_*` | The Android build: URL, version, build, size, date, minimum Android, changelog |
| `VITE_APP_VERSION`, `VITE_BUILD_DATE` | Stamped into the footer |
| `VITE_COMPANY_NAME` | Legal name in the copyright line |

### The APK, specifically

**The release APK is about 124 MB, which is past the file size a Vercel
deployment will carry.** Putting it in `public/` fails the build rather than
serving it, so `VITE_APK_URL` should point somewhere that can hold it:

```bash
VITE_APK_URL=https://github.com/<owner>/<repo>/releases/latest/download/orbit-field.apk
```

A deployment with no such limit — your own server, an S3 bucket behind a
domain — can drop the file into `public/` and set `VITE_APK_URL=/orbit-field.apk`.

The button reads the URL and tells the truth about it. When it ends in `.apk`
the button downloads; otherwise it says it is going to a releases page. Left
unset entirely, it points at the repository's latest release. It never promises
a download the deployment cannot give.

The changelog is a pipe-separated list, shown in full:

```bash
VITE_APK_CHANGELOG=Faster photo compression|Stylus support for signatures
```

## Deploying to Vercel

The repository is an npm workspace, so the build has to run from the root.

1. **New Project** → import the repository.
2. **Root Directory**: `apps/landing`.
3. **Framework Preset**: Other. `vercel.json` already sets the commands:
   - Install: `cd ../.. && npm install`
   - Build: `cd ../.. && npm run build -w @orbit/landing`
   - Output: `dist`
4. Add the environment variables you want to override. None is required.
5. Deploy.

From the command line, run it **from the repository root** rather than this
directory — with a Root Directory set, Vercel resolves the path again and
`apps/landing/apps/landing` does not exist:

```bash
npx vercel link --yes --project orbit-field-landing
npx vercel --prod --yes
```

To stamp the footer with the real build date, set `VITE_BUILD_DATE` in the
project's environment variables:

```bash
VITE_BUILD_DATE=$(date -u +%Y-%m-%d)
```

## Screenshots

`public/screenshots/` is empty and the five frames are honest placeholders that
say what belongs in them. To use a real capture: put the file in that folder,
set `image` on the matching entry in `src/components/Screenshots.tsx`, and the
placeholder is replaced. The aspect ratio is already reserved, so nothing on
the page shifts.

## Design notes

The palette is the product's own state machine rather than a brand guess.
**Amber** is work queued on a device with no signal; **cyan** is work that has
reconciled. Those are the two states the sync engine actually has, which is why
the hero shows a change log moving between them instead of a headline number —
the moment an inspector's offline work merges is the whole product, so it is
the thing the page opens with.

Type is Space Grotesk for display and IBM Plex Sans and Mono for everything
else: Plex was drawn for technical documentation, and the mono carries versions,
build numbers and state labels the way a datasheet would.

Themes are **semantic tokens, not `dark:` variants**. Components say what a
colour is for — `text-fg`, `bg-raised`, `border-hairline` — and `styles.css`
decides what it is. An earlier version had components choose per-variant and got
it wrong in most of them, rendering near-white headings on a near-white
background in light mode. With tokens that mistake is unavailable.

Dark is the default because the design is built on it and the amber only reads
as high-visibility against a dark ground. A visitor who has never chosen gets
whatever their system asks for, applied before first paint so no one sees the
wrong theme flash past.

## Accessibility

- A skip link is the first thing a keyboard reaches.
- Focus is never removed; one amber ring, everywhere, against whichever ground.
- `prefers-reduced-motion` stops all of it. Nothing animated carries meaning
  that is lost when it stops — the ledger renders fully reconciled instead.
- Decorative SVG is `aria-hidden`; every control has a name that says what it
  does.
- Both themes meet WCAG AA for body text; the amber is darkened to a burnt
  orange in light mode, where the field amber would not.

## What this does not touch

Nothing. No file outside `apps/landing` was changed to add it beyond
registering the workspace in the root `package.json`. It has no dependency on
the backend, the portal, the console, the mobile app, the database or any
shared package.
