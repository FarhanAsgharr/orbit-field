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

export function validate(shape: RequestSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
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
