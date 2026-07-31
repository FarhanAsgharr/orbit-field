/**
 * What the software actually looks like.
 *
 * Every image here is a capture of the running product — the console and the
 * portal from production, the two phone screens from the release APK on an
 * emulator. Nothing is a mockup, and nothing is a stock photograph of a laptop:
 * a landing page that shows a product other than the one being sold is worse
 * than one that shows nothing.
 *
 * The data in them is demo data belonging to the seeded demo company. No real
 * customer, no real address, and no email that belongs to a person — the two
 * console captures are aggregate screens by choice, because the pages that
 * list people would have put real addresses on a public page.
 *
 * `alt` describes what the screen shows rather than naming the file. Somebody
 * reading this with a screen reader should learn what the product does, which
 * is the same thing the image is there to convey.
 */

import { motion } from 'framer-motion';

interface Shot {
  name: string;
  shows: string;
  image: string;
  alt: string;
  shape: 'wide' | 'phone';
}

const SHOTS: Shot[] = [
  {
    name: 'Admin Dashboard',
    shows: 'Fleet position and the day’s exceptions',
    image: '/screenshots/admin-dashboard.webp',
    alt: 'The Orbit Field admin console overview. A banner reports three devices silent for 24 hours, a fleet position chart plots devices against the server cursor, and tiles show 23 inspections in the last 30 days, a 26.1 per cent completion rate, a zero per cent failure rate and two overdue.',
    shape: 'wide',
  },
  {
    name: 'Client Portal',
    shows: 'A customer tracking their requests',
    image: '/screenshots/client-portal.webp',
    alt: 'The client portal for Meridian Property Group. Tiles show three requests awaiting review, none needing a reply, one in progress and none completed, above a table of recent requests for a fire safety inspection, a roof membrane survey and a quarterly lift check, each marked pending approval.',
    shape: 'wide',
  },
  {
    name: 'Android App',
    shows: 'An inspector’s work for the day',
    image: '/screenshots/android-app.webp',
    alt: 'The Orbit Field Android app dashboard. Three inspections are open, none due today and none overdue. A device status card reports the app online with all changes saved to the server, fifteen photographs pending upload, and a sync-now button. Below, the next job is an annual fire safety inspection at Bishopsgate Tower for Meridian Property Group.',
    shape: 'phone',
  },
  {
    name: 'Analytics',
    shows: 'Throughput, and where failures concentrate',
    image: '/screenshots/analytics.webp',
    alt: 'The analytics screen of the admin console, covering the last 90 days by week. Headline figures show 23 inspections, a 26.1 per cent completion rate and a zero per cent failure rate, above a chart plotting created, completed and failed inspections over time, and a table of inspector throughput.',
    shape: 'wide',
  },
  {
    name: 'Inspection screen',
    shows: 'A checklist part-way through, saved offline',
    image: '/screenshots/inspection.webp',
    alt: 'An inspection open on the Android app: annual fire safety inspection at Tower B, two of four questions answered and scored 86 per cent, marked saved just now. A pass-fail question — is the condition satisfactory? — has satisfactory selected over defect found and not applicable, followed by a photograph requirement with buttons to take a photo or choose from the gallery, and a note that none of five are attached and one is required.',
    shape: 'phone',
  },
];

function Frame({ shot }: { shot: Shot }) {
  const ratio = shot.shape === 'phone' ? 'aspect-[9/16]' : 'aspect-[16/10]';

  return (
    <figure className="surface overflow-hidden rounded-lg">
      <div className={`relative ${ratio} w-full`}>
        <img
          src={shot.image}
          alt={shot.alt}
          /*
           * The intrinsic size is declared so the browser reserves the space
           * before the bytes arrive. The frame's aspect ratio already does
           * that, and these agree with it — belt and braces against a shift.
           */
          width={shot.shape === 'phone' ? 607 : 1440}
          height={shot.shape === 'phone' ? 1080 : 900}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-top"
        />
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
          /* The phone frames are twice the height of a wide one, so they span
             two rows and sit flush beside them. */
          className={shot.shape === 'phone' ? 'sm:row-span-2' : ''}
        >
          <Frame shot={shot} />
        </motion.div>
      ))}
    </div>
  );
}
