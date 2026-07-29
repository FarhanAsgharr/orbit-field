/**
 * Which company's portal is this?
 *
 * Every screen in this application belongs to exactly one company, and the
 * address the customer opened is what says which. Nothing is asked and nothing
 * is chosen: `portal.example.com/acme` is Acme's portal, and a customer of
 * Acme never learns that anybody else is on the platform.
 *
 * Two forms are supported, in this order:
 *
 *  1. **A hostname label** — `acme.portal.example.com`. Preferred, because the
 *     tenant is then part of the origin: cookies, storage and CSP all scope to
 *     it for free, and one company's portal cannot script another's.
 *  2. **The first path segment** — `portal.example.com/acme`. What this
 *     deployment actually uses, because wildcard DNS needs a paid Vercel plan
 *     and a domain, neither of which should block the architecture.
 *
 * Writing both now is what makes the upgrade a DNS change rather than a
 * rewrite: move the domain, and `subdomainTenant` starts winning on its own.
 */

/**
 * Hosts that never carry a tenant in their first label.
 *
 * `orbit-field-portal.vercel.app` is the deployment's own name, not a
 * customer's, and a preview build is `orbit-field-portal-abc123.vercel.app`.
 * Treating either as a company would send every visitor to a 404.
 */
const RESERVED_LABELS = new Set(['www', 'portal', 'localhost', 'app']);

/** Slugs the router uses for itself, which therefore cannot be a company. */
export const RESERVED_PATHS = new Set(['client', 'assets', 'favicon.ico', 'site.webmanifest']);

function subdomainTenant(hostname: string): string | null {
  const labels = hostname.split('.');

  // Needs at least `tenant.domain.tld` to carry a tenant label at all.
  if (labels.length < 3) return null;

  const first = labels[0]!.toLowerCase();
  if (RESERVED_LABELS.has(first)) return null;

  /*
   * Vercel's own deployment hostnames look like a tenant and are not one:
   * `orbit-field-portal.vercel.app` has two labels so it never reaches here,
   * but `orbit-field-portal-git-main-team.vercel.app` does. Anything ending in
   * vercel.app is infrastructure, so no tenant is read from it.
   */
  if (hostname.endsWith('.vercel.app')) return null;

  return first;
}

function pathTenant(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return null;
  const slug = first.toLowerCase();
  if (RESERVED_PATHS.has(slug)) return null;
  // Same shape the server allows, so a malformed segment is rejected here
  // rather than becoming a pointless request.
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) ? slug : null;
}

/**
 * The company this page is for, or null on the bare portal root.
 *
 * Null is a real state, not an error: somebody typed the portal's address
 * without a company. They get a page telling them to ask their company for its
 * link — never a list of companies to choose from.
 */
export function resolveTenant(
  location: { hostname: string; pathname: string } = window.location,
): string | null {
  return subdomainTenant(location.hostname) ?? pathTenant(location.pathname);
}

/** True when the tenant came from the hostname, so paths carry no company. */
export function tenantIsInHost(location: { hostname: string } = window.location): boolean {
  return subdomainTenant(location.hostname) !== null;
}

/**
 * Build an in-app path for the current tenant.
 *
 * On a subdomain deployment the company is already in the origin, so the path
 * must not repeat it — `acme.portal.example.com/acme/login` would be wrong.
 */
export function tenantPath(tenant: string | null, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (!tenant || tenantIsInHost()) return clean;
  return `/${tenant}${clean}`;
}
