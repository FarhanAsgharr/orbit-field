/**
 * Every destination, in one place.
 *
 * The hero offers the three doors most people want. This is the full set, for
 * the reader who scrolled past looking for the one that was not there.
 */
import { docs, links } from '../lib/config';

const DESTINATIONS = [
  { name: 'Client Portal', href: links.clientPortal, note: 'Customers' },
  { name: 'Admin Dashboard', href: links.adminDashboard, note: 'Staff' },
  { name: 'API Docs', href: docs.swagger, note: 'Engineers' },
  { name: 'GitHub', href: links.github, note: 'Source' },
  { name: 'Contact', href: links.contact, note: 'Anything else' },
];

export function QuickLinks() {
  return (
    <ul className="border-hairline grid gap-px border-t sm:grid-cols-2 lg:grid-cols-5">
      {DESTINATIONS.map((item) => (
        <li key={item.name} className="border-hairline border-b border-r">
          <a
            href={item.href}
            {...(item.href.startsWith('http')
              ? { target: '_blank', rel: 'noreferrer noopener' }
              : {})}
            className="group flex h-full flex-col justify-between gap-6 px-6 py-6 transition-colors hover:bg-raised"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest muted">
              {item.note}
            </span>
            <span className="flex items-center justify-between font-display text-sm font-semibold">
              {item.name}
              <span
                className="text-signal opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              >
                →
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
