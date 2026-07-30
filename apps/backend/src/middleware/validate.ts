/**
 * Request validation.
 *
 * Parsed output is written to `req.validated` rather than back onto `req.body`.
 * Overwriting `req.body` with a coerced object is a common source of subtle bugs
 * where a later middleware sees a different shape than the one it was written
 * against; keeping the raw input intact avoids that entirely.
 */

import type { NextFunction, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

export interface RequestSchema {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Where the validator records what it validates.
 *
 * The OpenAPI generator walks the mounted router and reads the schema off the
 * middleware it finds, so the document describes the rules the server is
 * actually applying. A symbol rather than a string key because this is
 * metadata for one reader, not part of the middleware's interface — nothing
 * should be tempted to branch on it at runtime.
 */
export const SCHEMA_MARKER = Symbol.for('orbit.requestSchema');

export function validate(shape: RequestSchema) {
  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.validated = {
        body: shape.body ? shape.body.parse(req.body) : undefined,
        query: shape.query ? shape.query.parse(req.query) : undefined,
        params: shape.params ? shape.params.parse(req.params) : undefined,
      };
      next();
    } catch (err) {
      // ZodError is translated to a 422 with field-level detail by the error
      // handler; nothing to do here but forward it.
      next(err);
    }
  };

  /*
   * Attached, not wrapped. The function returned is the same middleware Express
   * would otherwise receive, with a property hung off it — so request handling
   * is byte-for-byte what it was, and a generator that never runs costs
   * nothing at request time.
   */
  Object.defineProperty(middleware, SCHEMA_MARKER, { value: shape, enumerable: false });
  return middleware;
}

/** Common reusable fragments. */
export const schemas = {
  ulid: z.string().length(26, 'Must be a valid identifier'),
  email: z.string().email().max(320).toLowerCase().trim(),
  password: z.string().min(8).max(200),
  isoDate: z.string().datetime({ offset: true }),
  pagination: z.object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
  }),
};
