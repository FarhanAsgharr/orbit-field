/**
 * Terminal error handling.
 *
 * Two rules: every error leaves as the documented `ApiError` envelope, and no
 * 5xx ever leaks an internal message to the client. Internal detail goes to the
 * log with the request id; the client gets that id and nothing else.
 */

import { AppError, ErrorCode, statusForCode } from '@orbit/shared';
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '../config/env.js';

/** 404 for unmatched routes. Registered after all routers. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `No route matches ${req.method} ${req.path}.`,
      requestId: req.requestId,
    },
  });
}

function zodToFieldErrors(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || '_root';
    // Keep the first message per path; a field with three complaints is still
    // one field the user has to fix.
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

/** Map Prisma's error codes onto the API taxonomy. */
function translatePrisma(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return new AppError(
        ErrorCode.DUPLICATE_RESOURCE,
        `A record with this ${target} already exists.`,
      );
    }
    case 'P2003':
      return new AppError(ErrorCode.VALIDATION_FAILED, 'A referenced record does not exist.');
    case 'P2025':
      return new AppError(ErrorCode.NOT_FOUND, 'The requested record was not found.');
    case 'P2034':
      // Write conflict / deadlock — genuinely retryable.
      return new AppError(
        ErrorCode.LOCK_TIMEOUT,
        'The request conflicted with another write. Please retry.',
        { retryAfter: 1 },
      );
    default:
      return new AppError(ErrorCode.INTERNAL_ERROR, 'A database error occurred.', { cause: err });
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express identifies an error handler by arity; `next` must stay declared.
  _next: NextFunction,
): void {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError(ErrorCode.VALIDATION_FAILED, 'The submitted data is invalid.', {
      fields: zodToFieldErrors(err),
    });
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appError = translatePrisma(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    appError = new AppError(ErrorCode.MALFORMED_REQUEST, 'The request could not be processed.', {
      cause: err,
    });
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    appError = new AppError(ErrorCode.DB_UNAVAILABLE, 'The service is temporarily unavailable.', {
      retryAfter: 5,
      cause: err,
    });
  } else if (err instanceof SyntaxError && 'body' in err) {
    appError = new AppError(ErrorCode.MALFORMED_REQUEST, 'The request body is not valid JSON.');
  } else {
    appError = new AppError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', {
      isOperational: false,
      cause: err,
    });
  }

  const status = appError.status || statusForCode(appError.code);

  // 5xx is a defect worth paging on; 4xx is the API doing its job.
  if (status >= 500) {
    req.log.error(
      { err: appError.cause ?? appError, code: appError.code, path: req.path, method: req.method },
      appError.message,
    );
  } else {
    req.log.info({ code: appError.code, status, path: req.path }, appError.message);
  }

  if (appError.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(appError.retryAfter));
  }

  const body = appError.toJSON(req.requestId);

  // Never surface an internal message in production; the request id is the
  // bridge between what the user reports and what the logs contain.
  if (status >= 500 && isProduction) {
    body.error.message = 'An unexpected error occurred. Quote the request id when reporting this.';
  }

  res.status(status).json(body);
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
