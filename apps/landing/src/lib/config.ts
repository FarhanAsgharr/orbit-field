/**
 * Everything this site links to, and nothing it does itself.
 *
 * The landing page is a front desk: it owns no data and performs no action
 * except pointing four different audiences at the right door. So every
 * destination is configuration, not a constant buried in a component — a
 * deployment that moves the portal to its own domain should need an
 * environment variable, not a code change.
 *
 * The fallbacks are the addresses this platform is actually deployed at today.
 * A missing variable therefore degrades to "correct for the current
 * deployment" rather than to a dead link, which is the failure that matters
 * on a page whose entire job is links.
 */

const read = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : fallback;
};

const env = import.meta.env;

export const links = {
  clientPortal: read(env.VITE_CLIENT_PORTAL_URL, 'https://orbit-field-portal.vercel.app'),
  adminDashboard: read(env.VITE_ADMIN_DASHBOARD_URL, 'https://orbit-field-three.vercel.app'),
  api: read(env.VITE_API_URL, 'https://orbit-field-api.vercel.app'),
  github: read(env.VITE_GITHUB_URL, 'https://github.com/FarhanAsgharr/orbit-field'),
  contact: read(env.VITE_CONTACT_URL, 'mailto:hello@orbitfield.app'),
} as const;

/** The API serves all three of these itself; they are derived, not configured. */
export const docs = {
  swagger: `${links.api}/docs`,
  redoc: `${links.api}/redoc`,
  openapi: `${links.api}/openapi.json`,
} as const;

/**
 * The Android build on offer.
 *
 * `url` is deliberately not defaulted to a path inside this site. The release
 * APK is around 124 MB, and Vercel refuses to deploy a file that large — so a
 * build that dropped it into `public/` would fail rather than serve it. The
 * honest default is therefore the repository's releases page, with
 * `VITE_APK_URL` pointing at a real artefact once one is published; a
 * self-hosted deployment with no such limit can set it to `/orbit-field.apk`
 * and put the file in `public/`.
 *
 * `available` is what the download button reads. It is false when the URL
 * still points at a releases page rather than a file, so the button can say so
 * instead of promising a download it cannot give.
 */
const apkUrl = read(env.VITE_APK_URL, `${links.github}/releases/latest`);

export const apk = {
  url: apkUrl,
  version: read(env.VITE_APK_VERSION, '1.0.0'),
  build: read(env.VITE_APK_BUILD, '1'),
  size: read(env.VITE_APK_SIZE, '124 MB'),
  released: read(env.VITE_APK_RELEASE_DATE, '2026-07-25'),
  minAndroid: read(env.VITE_APK_MIN_ANDROID, '8.0'),
  /** True once the link points at an artefact rather than a releases index. */
  available: /\.apk($|\?)/i.test(apkUrl),
  changelog: read(
    env.VITE_APK_CHANGELOG,
    [
      'Client requests now reach the right company automatically',
      'Offline queue survives reinstall and device rebinding',
      'Faster photo compression on mid-range hardware',
      'Signature capture works with a stylus',
    ].join('|'),
  )
    .split('|')
    .map((line) => line.trim())
    .filter(Boolean),
} as const;

/** Stamped at build time, so the footer reports the deployed artefact. */
export const build = {
  version: read(env.VITE_APP_VERSION, '1.0.0'),
  date: read(env.VITE_BUILD_DATE, new Date().toISOString().slice(0, 10)),
} as const;

export const company = {
  name: 'Orbit Field',
  legal: read(env.VITE_COMPANY_NAME, 'Orbit Field'),
  tagline: 'Offline-First Enterprise Inspection Platform',
} as const;
