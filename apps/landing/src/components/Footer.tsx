/**
 * The footer.
 *
 * Carries the things a reader looks down here for: who made it, what version
 * they are looking at, and when it was built. The build stamp is not vanity —
 * it is the first thing worth quoting when something is wrong.
 */
import { Logo } from './Logo';
import { build, company, docs, links, social } from '../lib/config';

export function Footer() {
  return (
    <footer className="border-hairline border-t">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <Logo className="h-7" />
            <p className="mt-4 max-w-sm text-sm leading-relaxed muted">
              {company.tagline}. Built for companies whose work happens where the network does not
              reach.
            </p>
          </div>

          <div>
            <p className="spec-label">Platform</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li>
                <a href={links.clientPortal} className="transition-colors hover:text-signal muted">
                  Client Portal
                </a>
              </li>
              <li>
                <a
                  href={links.adminDashboard}
                  className="transition-colors hover:text-signal muted"
                >
                  Admin Dashboard
                </a>
              </li>
              <li>
                <a href="#download" className="transition-colors hover:text-signal muted">
                  Android App
                </a>
              </li>
            </ul>
          </div>

          <div>
            <p className="spec-label">Developers</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li>
                <a href={docs.swagger} className="transition-colors hover:text-signal muted">
                  API reference
                </a>
              </li>
              <li>
                <a href={docs.openapi} className="transition-colors hover:text-signal muted">
                  OpenAPI 3.1
                </a>
              </li>
              <li>
                <a href={links.github} className="transition-colors hover:text-signal muted">
                  Source
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-hairline mt-12 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[11px] muted">
            © {new Date().getFullYear()} {company.legal} · v{build.version} · built {build.date}
          </p>
          <ul className="flex gap-5">
            {social.map((item) => (
              <li key={item.name}>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-[11px] transition-colors hover:text-signal muted"
                >
                  {item.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
