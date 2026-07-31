/**
 * The hero.
 *
 * This page has one job — put four different audiences through the right door
 * — so the actions are the content, not an afterthought under a slogan. The
 * left column states the thesis and offers the doors; the right shows the
 * mechanism the thesis rests on.
 *
 * The copy is deliberately not sales language. Somebody arriving here is
 * either a customer looking for their portal, an operator looking for the
 * console, an inspector looking for the app, or an engineer looking for the
 * API. Each of them wants a signpost, and none of them wants to be sold to.
 */

import { motion } from 'framer-motion';

import { SyncLedger } from './SyncLedger';
import { company, links } from '../lib/config';

const rise = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.06 * i, duration: 0.5, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

export function Hero() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-heading">
      <div
        className="grid-face pointer-events-none absolute inset-0 opacity-[0.6]"
        aria-hidden="true"
      />
      {/* A single warm bloom, where the eye lands first. */}
      <div
        className="pointer-events-none absolute -top-40 right-0 h-[32rem] w-[32rem] rounded-full bg-signal/[0.07] blur-3xl"
        aria-hidden="true"
      />

      <div className="relative mx-auto grid max-w-6xl gap-14 px-6 pb-20 pt-14 lg:grid-cols-[1.15fr_.85fr] lg:items-center lg:gap-16 lg:pb-24 lg:pt-20">
        <div>
          <motion.p
            initial="hidden"
            animate="show"
            custom={1}
            variants={rise}
            className="spec-label"
          >
            {company.tagline}
          </motion.p>

          <motion.h1
            id="hero-heading"
            initial="hidden"
            animate="show"
            custom={2}
            variants={rise}
            className="mt-4 font-display text-4xl font-bold leading-[1.06] tracking-tight text-fg sm:text-5xl lg:text-[3rem] xl:text-[3.4rem]"
          >
            Inspections that do not
            <br />
            <span className="text-signal">wait for a signal.</span>
          </motion.h1>

          <motion.p
            initial="hidden"
            animate="show"
            custom={3}
            variants={rise}
            className="mt-6 max-w-xl text-base leading-relaxed muted sm:text-lg"
          >
            Inspectors work in basements, plant rooms and sites with no coverage. Orbit Field runs
            entirely on the device and reconciles when the connection returns — with the audit
            trail, signatures and photographs intact.
          </motion.p>

          <motion.div
            initial="hidden"
            animate="show"
            custom={4}
            variants={rise}
            className="mt-10 flex flex-wrap gap-3"
          >
            <a
              href={links.clientPortal}
              className="rounded-md bg-signal px-5 py-3 font-display text-sm font-semibold text-canvas transition hover:bg-signal/90"
            >
              Open Client Portal
            </a>
            <a
              href={links.adminDashboard}
              className="border-hairline rounded-md border px-5 py-3 font-display text-sm font-semibold transition hover:border-sync hover:text-sync"
            >
              Open Admin Dashboard
            </a>
            <a
              href="#download"
              className="border-hairline rounded-md border px-5 py-3 font-display text-sm font-semibold transition hover:border-sync hover:text-sync"
            >
              Download Android APK
            </a>
          </motion.div>

          <motion.dl
            initial="hidden"
            animate="show"
            custom={5}
            variants={rise}
            className="border-hairline mt-12 grid max-w-lg grid-cols-3 gap-px overflow-hidden rounded-md border"
          >
            {[
              ['Roles', 'Owner to client'],
              ['Tenancy', 'One company each'],
              ['Offline', 'Indefinite'],
            ].map(([term, value]) => (
              <div key={term} className="bg-raised px-4 py-3">
                <dt className="font-mono text-[10px] uppercase tracking-widest muted">{term}</dt>
                <dd className="mt-1 font-display text-sm font-semibold">{value}</dd>
              </div>
            ))}
          </motion.dl>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.28, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <SyncLedger />
        </motion.div>
      </div>
    </section>
  );
}
