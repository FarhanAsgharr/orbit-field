/**
 * What the platform does.
 *
 * Laid out as a parts list rather than ten identical icon cards: each entry
 * carries a mono index and a hairline, the way a specification enumerates
 * components. The index is not a step — nothing here happens in order — it is
 * a catalogue reference, which is what a reader scanning for one capability
 * actually wants.
 *
 * Every line describes what the software does in plain terms. "Enterprise-grade
 * synchronisation infrastructure" tells a reader nothing; "resolves conflicting
 * edits field by field" tells them whether it will handle their problem.
 */

import { motion } from 'framer-motion';

interface Feature {
  name: string;
  detail: string;
  /** The two entries the whole product rests on are marked. */
  core?: boolean;
}

const FEATURES: Feature[] = [
  {
    name: 'Offline first',
    detail:
      'The device holds the whole checklist, the media and the queue. Work continues with the network gone for days.',
    core: true,
  },
  {
    name: 'Real-time sync',
    detail:
      'A change log replays in order when the connection returns, and resolves conflicting edits field by field rather than discarding one side.',
    core: true,
  },
  {
    name: 'GPS tracking',
    detail:
      'Position and accuracy are recorded at submission, with mocked locations refused so a report cannot claim a site nobody visited.',
  },
  {
    name: 'Photo capture',
    detail:
      'Watermarked, compressed on the device and uploaded in chunks that resume — a 20 MB drawing survives a dropped connection.',
  },
  {
    name: 'Digital signature',
    detail:
      'Captured on glass, bound to the inspection version that was signed, so a later edit cannot inherit the signature.',
  },
  {
    name: 'QR and barcode',
    detail: 'Scan an asset tag to open the right inspection instead of searching for it.',
  },
  {
    name: 'Analytics',
    detail:
      'Pass rates, inspector throughput and site history, scoped to the company asking and nobody else.',
  },
  {
    name: 'Reports',
    detail:
      'Signed-off work becomes a PDF or a spreadsheet on demand, generated from the pinned template version the inspector actually saw.',
  },
  {
    name: 'Push notifications',
    detail:
      'Assignment, review and rework reach the phone. The record is written whether or not the push is delivered.',
  },
  {
    name: 'Secure authentication',
    detail:
      'Device-bound sessions, rotating refresh tokens, and reuse treated as theft — the session family is burned.',
  },
];

export function Features() {
  return (
    <ul className="border-hairline grid gap-px border-t sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map((feature, index) => (
        <motion.li
          key={feature.name}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.4, delay: (index % 3) * 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="border-hairline group relative border-b border-r px-6 py-7 transition-colors hover:bg-raised"
        >
          <div className="flex items-baseline gap-3">
            <span
              className={`font-mono text-[11px] tabular-nums ${
                feature.core ? 'text-signal' : 'muted'
              }`}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className="font-display text-base font-semibold text-fg">{feature.name}</h3>
          </div>
          <p className="mt-3 pl-8 text-sm leading-relaxed muted">{feature.detail}</p>
          {/* A hairline that fills on hover: the one flourish, and it is quiet. */}
          <span
            className="absolute bottom-0 left-0 h-px w-0 bg-signal transition-all duration-300 group-hover:w-full"
            aria-hidden="true"
          />
        </motion.li>
      ))}
    </ul>
  );
}
