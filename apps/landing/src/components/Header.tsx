/**
 * The header.
 *
 * Sticky, because the page is long and the doors are the point — somebody four
 * screens down should not have to scroll back to reach the portal.
 */
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { links } from '../lib/config';

const NAV = [
  ['Features', '#features'],
  ['Architecture', '#architecture'],
  ['Download', '#download'],
  ['Docs', '#documentation'],
];

export function Header() {
  return (
    <header className="border-hairline sticky top-0 z-50 border-b bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
        <a href="#top" className="shrink-0">
          <Logo className="h-7" />
        </a>

        <nav aria-label="Sections" className="hidden gap-7 md:flex">
          {NAV.map(([label, href]) => (
            <a key={href} href={href} className="text-sm transition-colors hover:text-signal muted">
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <a
            href={links.clientPortal}
            className="hidden rounded-md bg-signal px-4 py-2 font-display text-sm font-semibold text-canvas transition hover:bg-signal/90 sm:block"
          >
            Client Portal
          </a>
        </div>
      </div>
    </header>
  );
}
