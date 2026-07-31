/**
 * How the pieces fit.
 *
 * Six cards in a row would say "we have six things" and nothing else. What a
 * reader wants from an architecture section is *which way the arrows point* —
 * so this is drawn as three tiers with the API in the middle, because that is
 * genuinely the shape: three clients, one API, two stores behind it.
 *
 * The clients are colour-coded to the products they are: the console's blue,
 * the portal's green and the field amber of the app. Somebody who has seen any
 * of the three will recognise which row is theirs.
 */

import { motion } from 'framer-motion';

interface Node {
  name: string;
  role: string;
  accent: string;
}

const CLIENTS: Node[] = [
  { name: 'Admin Dashboard', role: 'Owners, admins, supervisors', accent: 'text-sync' },
  { name: 'Client Portal', role: 'One per company', accent: 'text-portal' },
  { name: 'Android App', role: 'Inspectors and supervisors', accent: 'text-signal' },
];

const STORES: Node[] = [
  { name: 'PostgreSQL', role: 'Records, change log, audit', accent: 'text-sync' },
  { name: 'Redis', role: 'Sessions, rate limits, queues', accent: 'text-sync' },
];

function Card({ node }: { node: Node }) {
  return (
    <div className="surface rounded-md px-5 py-4">
      <p className={`font-display text-sm font-semibold ${node.accent}`}>{node.name}</p>
      <p className="mt-1 font-mono text-[11px] leading-relaxed muted">{node.role}</p>
    </div>
  );
}

/** A vertical connector, so the tiers read as connected rather than stacked. */
function Wire({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-3" aria-hidden="true">
      <span className="h-6 w-px bg-hairline" />
      <span className="font-mono text-[10px] uppercase tracking-widest muted">{label}</span>
      <span className="h-6 w-px bg-hairline" />
    </div>
  );
}

export function Architecture() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6 }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {CLIENTS.map((node) => (
          <Card key={node.name} node={node} />
        ))}
      </div>

      <Wire label="HTTPS · bearer token · device id" />

      {/* The API is the only thing that talks to the stores, so it is drawn wide. */}
      <div className="surface rounded-md border-signal/30 px-5 py-5 text-center">
        <p className="font-display text-base font-semibold text-signal">Backend API</p>
        <p className="mt-1 font-mono text-[11px] muted">
          Express · every query scoped by organisation · 144 documented operations
        </p>
      </div>

      <Wire label="pooled connections" />

      <div className="grid gap-3 sm:grid-cols-2">
        {STORES.map((node) => (
          <Card key={node.name} node={node} />
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-sm leading-relaxed muted">
        Each company is a separate tenant. A record belonging to another company answers{' '}
        <span className="font-mono text-signal">404</span>, not{' '}
        <span className="font-mono">403</span> — confirming that it exists would itself disclose
        something.
      </p>
    </motion.div>
  );
}
