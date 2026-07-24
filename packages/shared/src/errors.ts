/**
 * Error taxonomy.
 *
 * Codes are the contract: the mobile app branches on `code`, never on the
 * message, so wording can change without breaking a client that is already
 * installed on a device somewhere with no upgrade path.
 */

export const ErrorCode = {
  // 400 / 422
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_PROTOCOL_VERSION: 'UNSUPPORTED_PROTOCOL_VERSION',

  // 401
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_REVOKED: 'AUTH_TOKEN_REVOKED',
  AUTH_OTP_INVALID: 'AUTH_OTP_INVALID',
  AUTH_OTP_EXPIRED: 'AUTH_OTP_EXPIRED',
  AUTH_BIOMETRIC_FAILED: 'AUTH_BIOMETRIC_FAILED',

  // 403
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  DEVICE_NOT_ENROLLED: 'DEVICE_NOT_ENROLLED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  ORG_MISMATCH: 'ORG_MISMATCH',
  PASSWORD_EXPIRED: 'PASSWORD_EXPIRED',

  // 404 / 410
  NOT_FOUND: 'NOT_FOUND',
  GONE: 'GONE',

  // 409
  CONFLICT: 'CONFLICT',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // 413 / 415
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',

  // Sync-specific
  SYNC_CURSOR_TOO_OLD: 'SYNC_CURSOR_TOO_OLD',
  SYNC_BATCH_ABORTED: 'SYNC_BATCH_ABORTED',
  SYNC_DEPENDENCY_FAILED: 'SYNC_DEPENDENCY_FAILED',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_INCOMPLETE: 'UPLOAD_INCOMPLETE',

  // Client-side only
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  OFFLINE: 'OFFLINE',
  LOCAL_STORAGE_FULL: 'LOCAL_STORAGE_FULL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  MALFORMED_REQUEST: 400,
  UNSUPPORTED_PROTOCOL_VERSION: 400,

  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_REVOKED: 401,
  AUTH_OTP_INVALID: 401,
  AUTH_OTP_EXPIRED: 401,
  AUTH_BIOMETRIC_FAILED: 401,

  PERMISSION_DENIED: 403,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_DEACTIVATED: 403,
  DEVICE_NOT_ENROLLED: 403,
  DEVICE_REVOKED: 403,
  DEVICE_LIMIT_REACHED: 403,
  ORG_MISMATCH: 403,
  PASSWORD_EXPIRED: 403,

  NOT_FOUND: 404,
  GONE: 410,

  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  DUPLICATE_RESOURCE: 409,
  INVALID_STATE_TRANSITION: 409,

  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CHECKSUM_MISMATCH: 422,

  RATE_LIMITED: 429,
  TOO_MANY_ATTEMPTS: 429,

  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  DB_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 503,
  LOCK_TIMEOUT: 503,

  SYNC_CURSOR_TOO_OLD: 409,
  SYNC_BATCH_ABORTED: 503,
  SYNC_DEPENDENCY_FAILED: 424,
  UPLOAD_SESSION_EXPIRED: 410,
  UPLOAD_INCOMPLETE: 400,
};

export function statusForCode(code: ErrorCode | string): number {
  return STATUS_BY_CODE[code as ErrorCode] ?? 500;
}

/** Application error carrying an HTTP status and a stable machine code. */
export class AppError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly retryAfter?: number;
  /** False for expected conditions, so log noise stays proportional. */
  readonly isOperational: boolean;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode | string,
    message: string,
    options: {
      status?: number;
      fields?: Record<string, string>;
      retryAfter?: number;
      isOperational?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.fields = options.fields;
    this.retryAfter = options.retryAfter;
    this.isOperational = options.isOperational ?? this.status < 500;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON(requestId: string): {
    error: {
      code: string;
      message: string;
      fields?: Record<string, string>;
      requestId: string;
      retryAfter?: number;
    };
  } {
    return {
      error: {
        code: String(this.code),
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        requestId,
        ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      },
    };
  }
}

export const notFound = (resource: string, id?: string): AppError =>
  new AppError(ErrorCode.NOT_FOUND, id ? `${resource} ${id} was not found.` : `${resource} was not found.`);

export const forbidden = (message = 'You do not have permission to perform this action.'): AppError =>
  new AppError(ErrorCode.PERMISSION_DENIED, message);

export const unauthorized = (code: ErrorCode = ErrorCode.AUTH_REQUIRED, message = 'Authentication is required.'): AppError =>
  new AppError(code, message);

export const validationFailed = (fields: Record<string, string>, message = 'The submitted data is invalid.'): AppError =>
  new AppError(ErrorCode.VALIDATION_FAILED, message, { fields });

export const conflict = (message: string, code: ErrorCode = ErrorCode.CONFLICT): AppError =>
  new AppError(code, message);

export const invalidTransition = (from: string, to: string): AppError =>
  new AppError(ErrorCode.INVALID_STATE_TRANSITION, `An inspection cannot move from ${from} to ${to}.`);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
