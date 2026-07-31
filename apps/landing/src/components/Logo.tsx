/**
 * The mark.
 *
 * A ring with a satellite — the same glyph the console and the portal already
 * use, so the three read as one platform. Drawn rather than imported so it
 * inherits colour and needs no network request.
 */
export function Logo({ className = 'h-8' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <svg viewBox="0 0 32 32" className="h-full w-auto" role="img" aria-label="Orbit Field">
        <circle cx="16" cy="17" r="9" className="fill-none stroke-signal" strokeWidth="2.5" />
        <circle cx="24.5" cy="8" r="3.6" className="fill-sync" />
      </svg>
      <span className="font-display text-lg font-bold tracking-tight text-fg">Orbit Field</span>
    </span>
  );
}
