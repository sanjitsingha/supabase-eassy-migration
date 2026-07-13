/**
 * @file Domain constants for the Nebkern Migration Tool.
 *
 * Centralises the knowledge that is *specific to how Supabase lays out a
 * Postgres database*. Getting these classifications wrong is the single most
 * common cause of a broken migration, so they live in one audited place rather
 * than being scattered as string literals across the codebase.
 */

/**
 * Schemas that Supabase (or Postgres) provisions and owns itself.
 *
 * A freshly-created Supabase project *already has* `auth.users`,
 * `storage.objects`, etc. Their DDL is an implementation detail of the platform
 * version running on the destination, and re-creating it from the source would
 * either fail outright or — worse — silently downgrade the destination to the
 * source's older schema. So for these schemas we migrate **data only** and never
 * emit DDL.
 */
export const MANAGED_SCHEMAS = [
  'auth',
  'storage',
  'realtime',
  'supabase_functions',
  'supabase_migrations',
  'vault',
  'graphql',
  'graphql_public',
  'pgsodium',
  'pgsodium_masks',
  'extensions',
  'net',
  'cron',
  'pgbouncer',
  '_analytics',
  '_realtime',
  '_supavisor',
] as const;

/**
 * Schemas that are never touched at all — internal Postgres catalogs and the
 * TOAST/temp namespaces. Neither DDL nor data is read from these.
 */
export const SYSTEM_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'pg_temp_1',
  'pg_toast_temp_1',
] as const;

/**
 * Tables inside managed schemas whose *data* we do migrate, in dependency order.
 *
 * Order matters: `auth.users` must exist before `auth.identities` can reference
 * it. Anything in a managed schema that is not on this list is deliberately left
 * alone (e.g. `auth.schema_migrations`, `storage.migrations` — these describe the
 * destination's own platform version and must not be overwritten).
 */
export const MANAGED_DATA_TABLES: readonly { schema: string; table: string; stage: 'auth' | 'storage' }[] = [
  { schema: 'auth', table: 'users', stage: 'auth' },
  { schema: 'auth', table: 'identities', stage: 'auth' },
  { schema: 'auth', table: 'mfa_factors', stage: 'auth' },
  { schema: 'auth', table: 'mfa_challenges', stage: 'auth' },
  { schema: 'auth', table: 'mfa_amr_claims', stage: 'auth' },
  { schema: 'auth', table: 'sessions', stage: 'auth' },
  { schema: 'auth', table: 'refresh_tokens', stage: 'auth' },
  { schema: 'auth', table: 'sso_providers', stage: 'auth' },
  { schema: 'auth', table: 'sso_domains', stage: 'auth' },
  { schema: 'auth', table: 'saml_providers', stage: 'auth' },
  { schema: 'auth', table: 'saml_relay_states', stage: 'auth' },
  { schema: 'auth', table: 'flow_state', stage: 'auth' },
  { schema: 'auth', table: 'one_time_tokens', stage: 'auth' },
  { schema: 'storage', table: 'buckets', stage: 'storage' },
  { schema: 'storage', table: 'objects', stage: 'storage' },
  { schema: 'storage', table: 's3_multipart_uploads', stage: 'storage' },
];

/**
 * Extensions that Supabase installs and manages itself. `CREATE EXTENSION` for
 * these is either a no-op or an error on the destination, so they are filtered
 * out of the extensions stage.
 */
export const MANAGED_EXTENSIONS = [
  'plpgsql',
  'pg_graphql',
  'pg_stat_statements',
  'pgcrypto',
  'pgjwt',
  'pgsodium',
  'supabase_vault',
  'uuid-ossp',
] as const;

/** Roles that exist on every Supabase instance; never re-created, only granted to. */
export const SUPABASE_ROLES = [
  'anon',
  'authenticated',
  'service_role',
  'postgres',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_realtime_admin',
  'dashboard_user',
  'authenticator',
  'pgbouncer',
] as const;

/** The publication Supabase Realtime subscribes to. */
export const REALTIME_PUBLICATION = 'supabase_realtime';

/** Name of the SQL-execution helper installed for the RPC transport. */
export const EXEC_SQL_FUNCTION = 'nebkern_exec_sql';

/** Tunable defaults, all overridable per-migration from the Settings page. */
export const DEFAULTS = {
  /** Rows fetched/inserted per round-trip during the data stage. */
  batchSize: 1000,
  /** Tables copied concurrently. */
  tableConcurrency: 4,
  /** Storage objects transferred concurrently. */
  storageConcurrency: 6,
  /** Attempts per unit of work before it is recorded as failed and skipped. */
  maxRetries: 5,
  /** Base delay for exponential backoff, in milliseconds. */
  retryBaseDelayMs: 500,
  /** Ceiling for exponential backoff, in milliseconds. */
  retryMaxDelayMs: 30_000,
  /** Files at or above this size use resumable (TUS) multipart upload. */
  multipartThresholdBytes: 6 * 1024 * 1024,
  /** Chunk size for multipart uploads. */
  multipartChunkBytes: 6 * 1024 * 1024,
  /** 0 = unlimited. Applied to storage byte transfer via a token bucket. */
  bandwidthLimitBytesPerSec: 0,
  /** Per-request timeout for HTTP calls to Supabase APIs. */
  requestTimeoutMs: 120_000,
  /** Statement timeout applied to introspection/DDL SQL. */
  statementTimeoutMs: 300_000,
} as const;

/** How long an unlocked credential lives in the in-memory vault before auto-wipe. */
export const VAULT_TTL_MS = 60 * 60 * 1000;

/** Directory (relative to cwd) holding job state and logs. */
export const DATA_DIR = '.nebkern';
