/**
 * The sync ledger — the page's signature element.
 *
 * Every other landing page for a platform like this opens with a big number
 * and a gradient. The most characteristic thing in Orbit Field's world is not
 * a number: it is the moment work an inspector did in a basement with no
 * signal reconciles with the server. That is the whole product.
 *
 * So the hero shows it happening. Operations arrive QUEUED in field amber and
 * settle to SYNCED in cyan, on a device-minted identifier and a Lamport clock
 * — which is genuinely how the sync engine orders work that happened while
 * offline. The colours are not chosen to look technical; they are the two
 * states the system actually has.
 *
 * It is a depiction, not a live feed. Claiming otherwise on a marketing page
 * would be a lie told in the one place the product is meant to be explaining
 * itself honestly, so the caption says what it is.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';

interface Operation {
  id: string;
  entity: string;
  action: string;
  lamport: number;
}

/** The kind of work a device queues on a site with no coverage. */
const OPERATIONS: Operation[] = [
  { id: '01KYQ4', entity: 'INSPECTION', action: 'response.set', lamport: 412 },
  { id: '01KYQ7', entity: 'ATTACHMENT', action: 'photo.capture', lamport: 413 },
  { id: '01KYQ9', entity: 'INSPECTION', action: 'signature.add', lamport: 414 },
  { id: '01KYQB', entity: 'ASSET', action: 'barcode.scan', lamport: 415 },
  { id: '01KYQD', entity: 'INSPECTION', action: 'status.submit', lamport: 416 },
];

export function SyncLedger() {
  const still = useReducedMotion();
  /** How many rows have reconciled. Advances on a slow loop. */
  const [synced, setSynced] = useState(still ? OPERATIONS.length : 0);

  useEffect(() => {
    if (still) return;
    const step = setInterval(() => {
      setSynced((n) => (n >= OPERATIONS.length ? 0 : n + 1));
    }, 1400);
    return () => clearInterval(step);
  }, [still]);

  const offline = synced < OPERATIONS.length;

  return (
    <div className="surface relative overflow-hidden rounded-lg">
      {/* A scanning sweep, the way a field controller shows it is working. */}
      {!still && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="animate-sweep h-full w-1/3 bg-gradient-to-r from-transparent via-sync/[0.06] to-transparent" />
        </div>
      )}

      <header className="border-hairline flex items-center justify-between border-b px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-widest muted">
          Device change log
        </span>
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              offline ? 'bg-signal animate-sync-pulse' : 'bg-sync'
            }`}
          />
          <span className={offline ? 'text-signal' : 'text-sync'}>
            {offline ? 'No signal' : 'Reconciled'}
          </span>
        </span>
      </header>

      <ol className="divide-y divide-hairline/60 font-mono text-xs">
        {OPERATIONS.map((op, index) => {
          const done = index < synced;
          return (
            <li
              key={op.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5"
            >
              <span className="muted tabular-nums">{op.id}</span>
              <span className="truncate">
                <span className={done ? 'text-sync' : 'text-signal'}>{op.entity}</span>
                <span className="muted"> · {op.action}</span>
              </span>
              <motion.span
                key={`${op.id}-${done}`}
                initial={still ? false : { opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28 }}
                className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                  done ? 'bg-sync/10 text-sync' : 'bg-signal/10 text-signal'
                }`}
              >
                {done ? 'Synced' : 'Queued'}
              </motion.span>
            </li>
          );
        })}
      </ol>

      <footer className="border-hairline border-t px-4 py-3">
        <p className="font-mono text-[10px] leading-relaxed muted">
          Illustration of the sync engine. Operations are ordered by a Lamport clock and identified
          by the device, so work done offline merges without a server round trip.
        </p>
      </footer>
    </div>
  );
}
