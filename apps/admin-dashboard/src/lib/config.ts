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
/** The Client Portal's origin. Company-specific paths hang off it. */
export const PORTAL_ORIGIN = (
  (import.meta.env.VITE_PORTAL_URL as string | undefined) ?? 'https://orbit-field-portal.vercel.app'
).replace(/\/+$/, '');

/**
 * This company's own portal address.
 *
 * Every company has its own — `…/acme` is Acme's and shows no sign that anyone
 * else uses the platform. Administrators hand this link to their customers,
 * which is the only way in: there is no directory to browse and no company
 * picker to get wrong.
 *
 * Built from the slug rather than stored, so it stays correct if the portal
 * moves to a domain of its own. Moving to `acme.portal.example.com` later
 * changes this one function and nothing else.
 */
export function portalUrlFor(slug: string | null | undefined): string | null {
  return slug ? `${PORTAL_ORIGIN}/${slug}` : null;
}

/** Where a client account signs in. Used in the hand-over instructions. */
export const PORTAL_URL = PORTAL_ORIGIN;
