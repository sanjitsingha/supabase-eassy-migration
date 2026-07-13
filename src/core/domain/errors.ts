/**
 * @file Error taxonomy.
 *
 * The distinction that matters here is `retryable`. The orchestrator's whole
 * error policy hangs off it: a retryable error (socket reset, 429, 503) goes back
 * into the retry loop with backoff; a non-retryable one (bad credentials, syntax
 * error in generated DDL) is recorded against the task and the migration moves on
 * rather than burning five attempts on something that will never succeed.
 */

export type ErrorCode =
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'NO_TRANSPORT'
  | 'SQL_ERROR'
  | 'HTTP_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'CANCELLED'
  | 'PAUSED'
  | 'VALIDATION_FAILED'
  | 'CREDENTIALS_EXPIRED'
  | 'INTERNAL';

export class MigrationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    // `cause` goes through the standard Error option so it shows up in stack traces
    // and `util.inspect` output rather than being a bespoke field.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

/** Thrown to unwind a stage when the user cancels. Never retried, never logged as failure. */
export class CancelledError extends MigrationError {
  constructor(message = 'Migration cancelled by user') {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}

/** Thrown to unwind a stage when the user pauses. State is checkpointed first. */
export class PausedError extends MigrationError {
  constructor(message = 'Migration paused by user') {
    super('PAUSED', message);
    this.name = 'PausedError';
  }
}

/**
 * Classifies an unknown thrown value.
 *
 * Postgres error codes are the reliable signal here — `40001` (serialization
 * failure) and `40P01` (deadlock) are transient by definition and *must* be
 * retried, whereas `42601` (syntax error) never will be. HTTP status codes get
 * the same treatment.
 */
export function toMigrationError(err: unknown, fallbackMessage = 'Unexpected error'): MigrationError {
  if (err instanceof MigrationError) return err;

  if (err instanceof Error) {
    const pgCode = (err as { code?: unknown }).code;
    if (typeof pgCode === 'string') {
      const retryable = RETRYABLE_PG_CODES.has(pgCode) || RETRYABLE_NODE_CODES.has(pgCode);
      return new MigrationError('SQL_ERROR', err.message, { retryable, detail: pgCode, cause: err });
    }
    // Undici/fetch network failures surface as a bare TypeError.
    if (err.name === 'TypeError' && /fetch failed|network|socket/i.test(err.message)) {
      return new MigrationError('CONNECTION_FAILED', err.message, { retryable: true, cause: err });
    }
    if (err.name === 'AbortError' || /timeout/i.test(err.message)) {
      return new MigrationError('TIMEOUT', err.message, { retryable: true, cause: err });
    }
    return new MigrationError('INTERNAL', err.message, { cause: err });
  }

  return new MigrationError('INTERNAL', fallbackMessage, { detail: String(err) });
}

/** Builds a MigrationError from an HTTP response, mapping status -> retryability. */
export function fromHttpStatus(status: number, body: string, context: string): MigrationError {
  if (status === 401 || status === 403) {
    return new MigrationError('AUTH_FAILED', `${context}: unauthorized (${status})`, { detail: body });
  }
  if (status === 404) {
    return new MigrationError('NOT_FOUND', `${context}: not found`, { detail: body });
  }
  if (status === 429) {
    return new MigrationError('RATE_LIMITED', `${context}: rate limited`, { retryable: true, detail: body });
  }
  if (status >= 500) {
    return new MigrationError('HTTP_ERROR', `${context}: server error (${status})`, { retryable: true, detail: body });
  }
  return new MigrationError('HTTP_ERROR', `${context}: failed (${status})`, { detail: body });
}

/** Transient Postgres SQLSTATEs worth another attempt. */
const RETRYABLE_PG_CODES = new Set<string>([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  'XX000', // internal_error — often a transient pooler hiccup on Supabase
]);

/** Node socket-level failures worth another attempt. */
const RETRYABLE_NODE_CODES = new Set<string>([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
