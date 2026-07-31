/**
 * Screenshot placeholders.
 *
 * No screenshots exist yet, and a stock image of a laptop would be worse than
 * an honest gap: it would show a product that is not this one. So each frame
 * says what belongs there and what it will show, in the right aspect ratio —
 * a phone is drawn as a phone — and drops in without a layout shift when the
 * real image arrives.
 *
 * Set `image` on an entry, put the file in `public/screenshots/`, and the
 * placeholder is replaced. Nothing else changes.
 */

import { motion } from 'framer-motion';

interface Shot {
  name: string;
  shows: string;
  /** A file in `public/screenshots/`, once one exists. */
  image?: string;
  shape: 'wide' | 'phone';
}

const SHOTS: Shot[] = [
  { name: 'Admin Dashboard', shows: 'The inspection queue and today’s assignments', shape: 'wide' },
  { name: 'Client Portal', shows: 'A customer tracking their request', shape: 'wide' },
  { name: 'Android App', shows: 'A checklist mid-inspection, offline', shape: 'phone' },
  { name: 'Analytics', shows: 'Pass rates and inspector throughput', shape: 'wide' },
  { name: 'Reports', shows: 'A signed-off inspection as a PDF', shape: 'phone' },
];

function Frame({ shot }: { shot: Shot }) {
  const ratio = shot.shape === 'phone' ? 'aspect-[9/16]' : 'aspect-[16/10]';

  return (
    <figure className="surface overflow-hidden rounded-lg">
      <div className={`relative ${ratio} w-full`}>
        {shot.image ? (
          <img
            src={shot.image}
            alt={`${shot.name}: ${shot.shows}`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid-face absolute inset-0 grid place-items-center opacity-70">
            <div className="text-center">
              <span className="font-mono text-[10px] uppercase tracking-widest text-signal">
                Screenshot pending
              </span>
              <p className="mt-2 px-6 font-display text-sm font-semibold text-fg">{shot.name}</p>
            </div>
          </div>
        )}
      </div>
      <figcaption className="border-hairline border-t px-4 py-3">
        <p className="font-display text-sm font-semibold">{shot.name}</p>
        <p className="mt-0.5 font-mono text-[11px] muted">{shot.shows}</p>
      </figcaption>
    </figure>
  );
}

export function Screenshots() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SHOTS.map((shot, index) => (
        <motion.div
          key={shot.name}
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.45, delay: (index % 3) * 0.06, ease: [0.16, 1, 0.3, 1] }}
          /* The two phone frames are half-height, so they sit beside a wide one
             without stretching. */
          className={shot.shape === 'phone' ? 'sm:row-span-2' : ''}
        >
          <Frame shot={shot} />
        </motion.div>
      ))}
    </div>
  );
}
