/**
 * The Android build.
 *
 * A download button that does not say what it is about to give you is a button
 * people do not press. So the version, build number, size, release date and
 * minimum Android sit beside it as a spec block, and the changelog is open
 * rather than hidden behind a disclosure — four lines are not worth a click.
 *
 * The button tells the truth about what it can do. The release APK is around
 * 124 MB, which is past what a Vercel deployment will carry, so unless
 * `VITE_APK_URL` points at a real artefact the button goes to the releases
 * page and says so. Promising a download the deployment cannot serve would be
 * the one dishonest thing on the page.
 */

import { motion } from 'framer-motion';

import { apk } from '../lib/config';

const SPECS: Array<[string, string]> = [
  ['Version', apk.version],
  ['Build', apk.build],
  ['Size', apk.size],
  ['Released', apk.released],
  ['Android', `${apk.minAndroid}+`],
];

export function Download() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="surface relative overflow-hidden rounded-lg"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-signal/[0.08] blur-3xl"
        aria-hidden="true"
      />

      <div className="relative grid gap-10 p-8 lg:grid-cols-[1fr_auto] lg:items-center lg:p-12">
        <div>
          <h3 className="font-display text-2xl font-bold tracking-tight text-fg">
            Orbit Field for Android
          </h3>
          <p className="mt-3 max-w-md leading-relaxed muted">
            The inspector and supervisor app. Installs as an APK — it is distributed by the company
            running the platform rather than through the Play Store.
          </p>

          <dl className="border-hairline mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-md border sm:grid-cols-5">
            {SPECS.map(([term, value]) => (
              <div key={term} className="bg-raised px-4 py-3">
                <dt className="font-mono text-[10px] uppercase tracking-widest muted">{term}</dt>
                <dd className="mt-1 font-mono text-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8">
            <p className="spec-label">What changed</p>
            <ul className="mt-3 space-y-2">
              {apk.changelog.map((line) => (
                <li key={line} className="flex gap-3 text-sm muted">
                  <span
                    className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-signal"
                    aria-hidden="true"
                  />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lg:w-64">
          <a
            href={apk.url}
            {...(apk.available
              ? { download: '' }
              : { target: '_blank', rel: 'noreferrer noopener' })}
            className="flex w-full items-center justify-center gap-3 rounded-md bg-signal px-6 py-4 font-display text-base font-semibold text-canvas transition hover:bg-signal/90"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {apk.available ? 'Download APK' : 'Go to releases'}
          </a>

          <p className="mt-3 text-center font-mono text-[11px] leading-relaxed muted">
            {apk.available
              ? `v${apk.version} · build ${apk.build} · ${apk.size}`
              : 'No build is published at this address yet.'}
          </p>

          <p className="mt-4 rounded-md border border-signal/25 bg-signal/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-signal">
            Android blocks installs from outside the Play Store by default. Allow it for your
            browser when prompted.
          </p>
        </div>
      </div>
    </motion.div>
  );
}
