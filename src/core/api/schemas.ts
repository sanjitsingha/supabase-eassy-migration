/**
 * @file Request validation schemas and shared API helpers.
 *
 * Every route parses its body through Zod before it touches a service. The parsed
 * types then flow straight into the domain types with no casts, which is what keeps
 * `any` out of the codebase at the one boundary where it usually creeps in.
 */

import { z } from 'zod';
import { NextResponse } from 'next/server';
import type { MigrationOptions, StageSelection, SupabaseCredentials } from '@/core/domain/types';
import { MigrationError, toMigrationError } from '@/core/domain/errors';
import { DEFAULTS } from '@/core/domain/constants';

export const databaseConnectionSchema = z.object({
  mode: z.enum(['rpc', 'connection_string', 'manual']),
  connectionString: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  ssl: z.enum(['disable', 'prefer', 'require', 'no-verify']).default('prefer'),
  poolerMode: z.enum(['direct', 'transaction', 'session']).default('direct'),
  connectionTimeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
});

export const credentialsSchema = z.object({
  type: z.enum(['cloud', 'self_hosted']),
  url: z.string().url('Must be a valid URL, e.g. https://api.example.com'),
  serviceRoleKey: z.string().min(10, 'The service role key looks too short'),
  accessToken: z.string().optional(),
  database: databaseConnectionSchema.optional(),
  dbPassword: z.string().optional(),
});

export const stageSelectionSchema = z.object({
  extensions: z.boolean(),
  tables: z.boolean(),
  data: z.boolean(),
  policies: z.boolean(),
  functions: z.boolean(),
  views: z.boolean(),
  triggers: z.boolean(),
  buckets: z.boolean(),
  storage_files: z.boolean(),
  auth_users: z.boolean(),
  edge_functions: z.boolean(),
  realtime: z.boolean(),
});

export const optionsSchema = z.object({
  batchSize: z.number().int().min(1).max(50_000).default(DEFAULTS.batchSize),
  tableConcurrency: z.number().int().min(1).max(32).default(DEFAULTS.tableConcurrency),
  storageConcurrency: z.number().int().min(1).max(32).default(DEFAULTS.storageConcurrency),
  maxRetries: z.number().int().min(1).max(20).default(DEFAULTS.maxRetries),
  bandwidthLimitBytesPerSec: z.number().int().min(0).default(DEFAULTS.bandwidthLimitBytesPerSec),
  multipartThresholdBytes: z.number().int().min(1024 * 1024).default(DEFAULTS.multipartThresholdBytes),
  includeSchemas: z.array(z.string()).default([]),
  excludeSchemas: z.array(z.string()).default([]),
  truncateBeforeCopy: z.boolean().default(false),
  onConflict: z.enum(['skip', 'update', 'error']).default('skip'),
  overwriteStorage: z.boolean().default(false),
  continueOnError: z.boolean().default(true),
});

export const testConnectionSchema = z.object({
  credentials: credentialsSchema,
  role: z.enum(['source', 'destination']),
});

export const discoverySchema = z.object({
  credentials: credentialsSchema,
});

export const createMigrationSchema = z.object({
  name: z.string().min(1).max(120),
  source: credentialsSchema,
  destination: credentialsSchema,
  selection: stageSelectionSchema,
  options: optionsSchema.partial().optional(),
});

/** Re-arms the in-memory vault so a job can resume after a server restart. */
export const armCredentialsSchema = z.object({
  source: credentialsSchema,
  destination: credentialsSchema,
});

export const logQuerySchema = z.object({
  search: z.string().optional(),
  levels: z.array(z.enum(['debug', 'info', 'warn', 'error', 'success'])).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  offset: z.number().int().min(0).optional(),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;

/**
 * Zod output → domain type.
 *
 * Drops a `database` block that carries no usable target, so an untouched form does
 * not present itself downstream as a configured-but-broken connection. `hasTarget`
 * is the test: a connection string, or a host.
 */
export function toCredentials(input: CredentialsInput): SupabaseCredentials {
  const db = input.database;

  // RPC mode needs no target at all — it authenticates with the service role key over
  // the API URL we already have. It is "configured" by virtue of being selected.
  const hasTarget =
    db !== undefined &&
    (db.mode === 'rpc'
      ? true
      : db.mode === 'connection_string'
        ? (db.connectionString ?? '').trim() !== ''
        : (db.host ?? '').trim() !== '');

  return {
    type: input.type,
    url: input.url,
    serviceRoleKey: input.serviceRoleKey,
    ...(input.accessToken !== undefined && input.accessToken !== '' ? { accessToken: input.accessToken } : {}),
    ...(input.dbPassword !== undefined && input.dbPassword !== '' ? { dbPassword: input.dbPassword } : {}),
    ...(hasTarget && db !== undefined ? { database: db } : {}),
  };
}

export function toOptions(input: Partial<z.infer<typeof optionsSchema>> | undefined): MigrationOptions {
  const parsed = optionsSchema.parse(input ?? {});
  return parsed;
}

export function toSelection(input: z.infer<typeof stageSelectionSchema>): StageSelection {
  return input;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly error: string;
  readonly code: string;
  readonly detail?: string;
}

/**
 * Turns any thrown value into a response.
 *
 * The status code is derived from the error's own classification rather than being
 * hard-coded per route, so a 429 from Supabase surfaces to the browser as a 429 and
 * the client's retry logic can do the right thing.
 */
export function errorResponse(err: unknown): NextResponse<ApiError> {
  if (err instanceof z.ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return NextResponse.json({ error: message, code: 'VALIDATION_FAILED' }, { status: 400 });
  }

  const error: MigrationError = toMigrationError(err);
  const status = statusFor(error);

  return NextResponse.json(
    { error: error.message, code: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
    { status },
  );
}

function statusFor(error: MigrationError): number {
  switch (error.code) {
    case 'AUTH_FAILED':
      return 401;
    case 'CREDENTIALS_EXPIRED':
      // 409 rather than 401: the request was well-formed and authorised, but the
      // server no longer holds the keys. The UI keys off this to re-prompt.
      return 409;
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION_FAILED':
      return 400;
    case 'UNSUPPORTED':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'NO_TRANSPORT':
    case 'CONNECTION_FAILED':
      return 502;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

export function notFound(what: string): NextResponse<ApiError> {
  return NextResponse.json({ error: `${what} not found`, code: 'NOT_FOUND' }, { status: 404 });
}
