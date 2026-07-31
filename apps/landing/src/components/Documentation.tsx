/**
 * The API reference.
 *
 * Three doors onto the same document, and the difference between them is worth
 * stating: Swagger UI will send a request, ReDoc reads better, and the raw
 * JSON is what you feed a code generator. A reader who knows which one they
 * want should not have to click to find out.
 */
import { motion } from 'framer-motion';

import { docs } from '../lib/config';

const DOORS = [
  {
    name: 'Swagger UI',
    href: docs.swagger,
    detail: 'Try an endpoint against the live API, with your own token.',
  },
  { name: 'ReDoc', href: docs.redoc, detail: 'The same document, laid out to read end to end.' },
  {
    name: 'OpenAPI JSON',
    href: docs.openapi,
    detail: 'The raw 3.1 document, for a client generator or an import.',
  },
];

export function Documentation() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {DOORS.map((door, index) => (
        <motion.a
          key={door.name}
          href={door.href}
          target="_blank"
          rel="noreferrer noopener"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.4, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
          className="surface group rounded-lg p-6 transition-colors hover:border-sync/50"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-fg">{door.name}</h3>
            <span
              className="text-sync transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            >
              →
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed muted">{door.detail}</p>
        </motion.a>
      ))}
    </div>
  );
}
