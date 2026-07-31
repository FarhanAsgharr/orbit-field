/**
 * Dark and light.
 *
 * Dark is the default because the ground of this design is instrument housing
 * at night, and the amber only reads as high-visibility against it. Light is a
 * printed datasheet — genuinely designed, not an inversion.
 *
 * The choice is remembered, and an untouched visitor gets whatever their
 * system asks for. The inline script in index.html applies it before first
 * paint so nobody sees the wrong theme flash past.
 */
import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

function current(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  // Read what the pre-paint script already decided, rather than deciding again.
  useEffect(() => setTheme(current()), []);

  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('light', next === 'light');
    localStorage.setItem('orbit.theme', next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="border-hairline grid h-9 w-9 place-items-center rounded-md border transition hover:border-signal hover:text-signal"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
