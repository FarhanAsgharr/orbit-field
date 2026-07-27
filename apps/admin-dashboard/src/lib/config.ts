/**
 * Deployment-time facts the console needs to know about its neighbours.
 *
 * The Client Portal is a separate deployment at its own address, so the
 * console cannot derive the URL — it has to be told. Two screens need it: the
 * signpost shown when a client account reaches the console by mistake, and the
 * handover text after an administrator creates a portal login.
 *
 * The fallback is the portal's production address rather than an empty string.
 * A missing environment variable should degrade to "probably right" rather
 * than to a broken link in the one message whose whole job is telling somebody
 * where to go.
 */
export const PORTAL_URL =
  (import.meta.env.VITE_PORTAL_URL as string | undefined) ??
  'https://orbit-field-portal.vercel.app/client/login';
