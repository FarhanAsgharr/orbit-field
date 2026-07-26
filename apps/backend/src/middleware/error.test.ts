/**
 * Terminal error handling.
 *
 * Two rules hold everywhere: every error leaves as the documented `ApiError`
 * envelope, and no 5xx ever carries an internal message to the client.
 *
 * The second is the one worth guarding. A Prisma error message names tables and
 * columns; a stack trace names file paths. Both are useful in a log and both
 * are reconnaissance in a response body. The client gets a request id, which is
 * the bridge between what a user reports and what the logs hold — and nothing
 * else.
 *
 * The handler is called directly here rather than through a route, because the
 * interesting inputs are error *types* rather than requests: a Prisma
 * initialisation failure cannot be provoked over HTTP without taking the
 * database down.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { errorHandler, notFoundHandler } from './error.js';

interface Captured {
  status: number;
  body: { error: { code: string; message: string; fields?: Record<string, string> } };
  headers: Record<string, string>;
}

/** Minimal request/response pair, with a logger the handler can use. */
function invoke(err: unknown, overrides: Partial<Request> = {}): Captured {
  const captured: Captured = { status: 0, body: { error: { code: '', message: '' } }, headers: {} };

  const req = {
    path: '/api/v1/test',
    method: 'POST',
    requestId: '01TESTREQUEST00000000000',
    log: { error: vi.fn(), info: vi.fn(), child: vi.fn() },
    ...overrides,
  } as unknown as Request;

  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Captured['body']) {
      captured.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
  } as unknown as Response;

  errorHandler(err, req, res, (() => undefined) as NextFunction);
  return captured;
}

describe('unmatched routes', () => {
  it('answer 404 in the same envelope as every other error', async () => {
    let status = 0;
    let body: { error: { code: string } } = { error: { code: '' } };
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: typeof body) {
        body = payload;
        return this;
      },
    } as unknown as Response;

    notFoundHandler({ path: '/nope', method: 'GET' } as Request, res);

    expect(status).toBe(404);
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('application errors', () => {
  it('pass through with their own code and message', async () => {
    const result = invoke(new AppError(ErrorCode.PERMISSION_DENIED, 'You cannot do that.'));

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(result.body.error.message).toBe('You cannot do that.');
  });

  it('carry a Retry-After header when the error names one', async () => {
    const result = invoke(
      new AppError(ErrorCode.TOO_MANY_ATTEMPTS, 'Slow down.', { retryAfter: 30 }),
    );

    // Without this a client has to guess, and every client guesses differently.
    expect(result.headers['retry-after']).toBe('30');
  });

  it('include the request id, which is what a user quotes when reporting', async () => {
    const result = invoke(new AppError(ErrorCode.NOT_FOUND, 'Gone.')) as Captured & {
      body: { error: { requestId?: string } };
    };
    expect(result.body.error.requestId).toBe('01TESTREQUEST00000000000');
  });
});

describe('schema validation failures', () => {
  it('become a field map the client can render beside each input', async () => {
    const schema = z.object({ email: z.string().email(), age: z.number().int().positive() });
    const parsed = schema.safeParse({ email: 'nope', age: -1 });
    expect(parsed.success).toBe(false);

    const result = invoke(parsed.success ? new Error('unreachable') : parsed.error);

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(result.body.error.fields?.email).toBeTruthy();
    expect(result.body.error.fields?.age).toBeTruthy();
  });

  it('keep one message per field, because a field with three complaints is still one fix', async () => {
    const schema = z.object({
      name: z
        .string()
        .min(5)
        .max(10)
        .regex(/^[a-z]+$/),
    });
    const parsed = schema.safeParse({ name: 'A1' });

    const result = invoke(parsed.success ? new Error('unreachable') : parsed.error);
    expect(Object.keys(result.body.error.fields ?? {})).toEqual(['name']);
  });

  it('label a top-level failure rather than dropping it', async () => {
    const parsed = z.string().safeParse(42);
    const result = invoke(parsed.success ? new Error('unreachable') : parsed.error);

    expect(result.body.error.fields?._root).toBeTruthy();
  });
});

describe('database errors', () => {
  const prismaError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('raw database text', {
      code,
      clientVersion: '5.0.0',
      meta,
    });

  it('map a unique-constraint violation to a conflict naming the field', async () => {
    const result = invoke(prismaError('P2002', { target: ['email'] }));

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
    expect(result.body.error.message).toMatch(/email/);
  });

  it('cope with a unique-constraint violation that names no field', async () => {
    const result = invoke(prismaError('P2002'));
    expect(result.body.error.message).toMatch(/field/);
  });

  it('map a foreign-key failure to a validation error, not a server fault', async () => {
    const result = invoke(prismaError('P2003'));

    // It is the caller's reference that is wrong; a 500 would tell them to
    // report a bug that is theirs.
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('map a missing record to 404', async () => {
    const result = invoke(prismaError('P2025'));
    expect(result.status).toBe(404);
  });

  it('map a write conflict to a retryable error with a delay', async () => {
    const result = invoke(prismaError('P2034'));

    expect(result.body.error.code).toBe(ErrorCode.LOCK_TIMEOUT);
    // Genuinely retryable, unlike most 5xx, so the client is told to retry
    // rather than surfacing a failure to the user.
    expect(result.headers['retry-after']).toBe('1');
  });

  it('never leak the raw database text for an unrecognised code', async () => {
    const result = invoke(prismaError('P9999'));

    expect(result.status).toBe(500);
    expect(result.body.error.message).not.toContain('raw database text');
  });

  it('treat an unreachable database as temporary rather than a defect', async () => {
    const err = new Prisma.PrismaClientInitializationError('cannot reach database', '5.0.0');
    const result = invoke(err);

    expect(result.body.error.code).toBe(ErrorCode.DB_UNAVAILABLE);
    expect(result.headers['retry-after']).toBe('5');
    expect(result.body.error.message).not.toContain('cannot reach database');
  });

  it('treat a malformed query as a bad request', async () => {
    const err = new Prisma.PrismaClientValidationError('argument x is missing', {
      clientVersion: '5.0.0',
    });
    const result = invoke(err);

    expect(result.body.error.code).toBe(ErrorCode.MALFORMED_REQUEST);
    expect(result.body.error.message).not.toContain('argument x is missing');
  });
});

describe('malformed request bodies', () => {
  it('are reported as bad JSON rather than a server fault', async () => {
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON at position 4'), {
      body: '{"a":}',
      status: 400,
    });

    const result = invoke(err);
    expect(result.body.error.code).toBe(ErrorCode.MALFORMED_REQUEST);
    expect(result.body.error.message).toMatch(/JSON/);
  });

  it('a plain SyntaxError with no body is still a server fault', async () => {
    // A parser error is the client's problem; a genuine `SyntaxError` thrown by
    // our own code is ours, and conflating them hides real defects.
    const result = invoke(new SyntaxError('something in our code'));
    expect(result.status).toBe(500);
  });
});

describe('anything else', () => {
  it('becomes a 500 that says nothing about the internals', async () => {
    const result = invoke(new Error('connection string postgres://user:hunter2@db'));

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(JSON.stringify(result.body)).not.toContain('hunter2');
  });

  it('handles a thrown string', async () => {
    const result = invoke('a string was thrown');
    expect(result.status).toBe(500);
  });

  it('handles a thrown null', async () => {
    const result = invoke(null);
    expect(result.status).toBe(500);
  });

  it('does not require the request logger to be present', async () => {
    // `req.log` is attached partway down the middleware chain; anything thrown
    // before that point reaches this handler without one. It used to throw
    // here, and Express served its own HTML error page in place of the
    // envelope.
    const result = invoke(new AppError(ErrorCode.MALFORMED_REQUEST, 'Too long.'), {
      log: undefined,
    } as Partial<Request>);

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe(ErrorCode.MALFORMED_REQUEST);
  });
});
