/**
 * The shell every section shares.
 *
 * The eyebrow is a datasheet field label rather than a step number: these
 * sections are not a sequence, and numbering them 01/02/03 would assert an
 * order the content does not have.
 */
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

export function Section({
  id,
  label,
  title,
  intro,
  children,
}: {
  id: string;
  label: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-6xl px-6 py-20 lg:py-28" aria-labelledby={`${id}-t`}>
      <motion.header
        initial={{ opacity: 0, y: 14 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="max-w-2xl"
      >
        <p className="spec-label">{label}</p>
        <h2
          id={`${id}-t`}
          className="mt-3 font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl"
        >
          {title}
        </h2>
        {intro && <p className="mt-4 leading-relaxed muted">{intro}</p>}
      </motion.header>
      <div className="mt-12">{children}</div>
    </section>
  );
}
