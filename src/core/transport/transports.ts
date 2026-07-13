/**
 * @file The three SQL transports.
 *
 * All three satisfy {@link SqlTransport}, so every repository above them is
 * written once and works against any Supabase instance regardless of how we got
 * a SQL channel to it. This is the abstraction that lets the tool honour "use the
 * Supabase APIs, not pg_dump": we still speak SQL (there is no other way to read
 * a schema out of Postgres), but we do it over Supabase's own HTTPS surfaces
 * wherever one is available, and only fall back to a raw socket when it isn't.
 *
 * | Transport        | Needs                  | Works on     | Notes                                   |
 * |------------------|------------------------|--------------|-----------------------------------------|
 * | `management_api` | Personal Access Token  | Cloud only   | Preferred: no DB password, no IPv6 issue|
 * | `rpc`            | Service role key       | Any          | Needs a one-time helper fn installed    |
 * | `postgres`       | DB password            | Any          | Only option for self-hosted introspection|
 */

import { Client, type ClientConfig, type QueryResult } from 'pg';
import type { SqlResult, SqlRow, SqlTransport, SslMode, SupabaseCredentials, TransportKind } from '@/core/domain/types';
import { MigrationError, toMigrationError } from '@/core/domain/errors';
import { EXEC_SQL_FUNCTION, DEFAULTS } from '@/core/domain/constants';
import { httpRequest, normaliseUrl, parseProjectRef, serviceHeaders } from '@/core/transport/http';
import { inlineParams } from '@/core/transport/sql';
import { isSessionless, resolveConnection, resolvePassword } from '@/core/transport/postgres-url';

const MANAGEMENT_API = 'https://api.supabase.com';

// ---------------------------------------------------------------------------
// Management API transport
// ---------------------------------------------------------------------------

/**
 * Runs SQL through `POST /v1/projects/{ref}/database/query`.
 *
 * This is the transport we *want* on Cloud. It needs no database password, works
 * over plain HTTPS (so it is immune to the IPv4-vs-IPv6 problem that now bites
 * direct `db.<ref>.supabase.co` connections), and is rate-limited rather than
 * connection-limited.
 *
 * It has no bind-parameter channel, so parameters are encoded into the statement
 * by {@link inlineParams}.
 */
class ManagementApiTransport implements SqlTransport {
  readonly kind: TransportKind = 'management_api';
  /** Multi-statement bodies run inside one implicit transaction server-side. */
  readonly supportsTransactions = true;

  constructor(
    private readonly projectRef: string,
    private readonly accessToken: string,
  ) {}

  async query<T extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    const statement = inlineParams(sql, params);

    const response = await httpRequest({
      method: 'POST',
      url: `${MANAGEMENT_API}/v1/projects/${this.projectRef}/database/query`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: statement }),
      context: 'Management API query',
      timeoutMs: DEFAULTS.statementTimeoutMs,
    });

    // The endpoint returns a bare JSON array of row objects; DDL yields `[]`.
    const rows = await response.json<unknown>();
    if (!Array.isArray(rows)) return { rows: [], rowCount: 0 };

    return { rows: rows as readonly T[], rowCount: rows.length };
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async dispose(): Promise<void> {
    // Stateless.
  }
}

// ---------------------------------------------------------------------------
// RPC transport
// ---------------------------------------------------------------------------

/**
 * Runs SQL through a `security definer` helper function reachable via PostgREST.
 *
 * The appeal is that it needs nothing but the service role key the user has
 * already given us. The catch is the chicken-and-egg: creating the helper itself
 * requires SQL access. So this transport is used when the helper *already exists*
 * (we install it via another transport, or the user pastes the bootstrap SQL we
 * show them in the UI).
 *
 * The helper is `security definer` and executes arbitrary SQL, which makes it a
 * full-database backdoor if it is ever reachable by `anon`. The bootstrap SQL
 * therefore revokes it from `public`/`anon`/`authenticated` and grants it only to
 * `service_role`, and {@link dropExecHelpers} removes it entirely once the
 * migration is done.
 */
class RpcTransport implements SqlTransport {
  readonly kind: TransportKind = 'rpc';
  /** Each RPC call is its own implicit transaction; we cannot span calls. */
  readonly supportsTransactions = false;

  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
  ) {}

  private async call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    const response = await httpRequest({
      method: 'POST',
      url: `${this.url}/rest/v1/rpc/${fn}`,
      headers: serviceHeaders(this.serviceRoleKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      context: `RPC ${fn}`,
      timeoutMs: DEFAULTS.statementTimeoutMs,
    });
    return response.json<T>();
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    const rows = await this.call<unknown>(EXEC_SQL_FUNCTION, { query: inlineParams(sql, params) });
    if (!Array.isArray(rows)) return { rows: [], rowCount: 0 };
    return { rows: rows as readonly T[], rowCount: rows.length };
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.call<null>(`${EXEC_SQL_FUNCTION}_ddl`, { query: inlineParams(sql, params) });
  }

  async dispose(): Promise<void> {
    // Stateless.
  }
}

// ---------------------------------------------------------------------------
// Direct Postgres transport
// ---------------------------------------------------------------------------

/**
 * A direct Postgres connection.
 *
 * The only transport that supports real bind parameters and multi-statement
 * transactions, and the only one available for a self-hosted instance (which has
 * no Management API at all). Uses a single long-lived `Client` rather than a Pool:
 * a migration runs its DDL strictly sequentially, and a single session means
 * `SET`s like `statement_timeout` and `session_replication_role` actually stick.
 */
class PostgresTransport implements SqlTransport {
  readonly kind: TransportKind = 'postgres';
  readonly supportsTransactions = true;

  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  /**
   * @param sessionless True when a transaction-mode pooler sits in front of Postgres.
   *   Such a pooler hands each statement to whichever backend is free, so session
   *   state does not survive between round-trips — issuing `SET` would either error or,
   *   worse, appear to succeed and then be silently discarded. We skip the session
   *   setup rather than rely on settings that will not be there.
   */
  constructor(
    private readonly config: ClientConfig,
    private readonly sessionless = false,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client !== null) return this.client;

    this.connecting ??= (async () => {
      const client = new Client(this.config);
      // A dead socket must invalidate the cached client, or every subsequent
      // query throws "Client has already been connected" instead of reconnecting.
      client.on('error', () => {
        this.client = null;
        this.connecting = null;
      });
      await client.connect();

      if (!this.sessionless) {
        await client.query(`SET statement_timeout = ${DEFAULTS.statementTimeoutMs}`);
        await client.query(`SET idle_in_transaction_session_timeout = 0`);
        // UTC keeps `timestamptz::text` cursors stable across resumes.
        await client.query(`SET TIME ZONE 'UTC'`);
      }

      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.connecting = null;
      throw toMigrationError(err, 'Postgres connection failed');
    }
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    const client = await this.connect();
    try {
      const result: QueryResult = await client.query(sql, params as unknown[]);
      return { rows: (result.rows ?? []) as readonly T[], rowCount: result.rowCount ?? 0 };
    } catch (err) {
      throw toMigrationError(err, 'Postgres query failed');
    }
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Connection-string derivation
// ---------------------------------------------------------------------------

/**
 * Maps our four SSL modes onto what `pg` expects.
 *
 * `no-verify` is the one that matters for self-hosting: it encrypts the connection
 * but skips certificate validation, which is exactly right for a database presenting
 * a self-signed cert or a cert issued for an internal hostname. Making the user pick
 * it explicitly is honest — quietly defaulting every connection to
 * `rejectUnauthorized: false` (as a lot of tools do) silently downgrades security on
 * connections that would have verified perfectly well.
 */
function sslConfig(mode: SslMode): ClientConfig['ssl'] {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: true };
    case 'no-verify':
      return { rejectUnauthorized: false };
    case 'prefer':
      // `pg` has no native "prefer". Attempt TLS without demanding a valid chain,
      // which is the closest honest equivalent and what almost every self-host needs.
      return { rejectUnauthorized: false };
  }
}

/**
 * Works out how to reach Postgres directly.
 *
 * Three sources, in order of specificity:
 *
 * 1. An explicit {@link DatabaseConnection} — a connection string or manual fields.
 *    This is the only thing that works for self-hosted, where the database may be on
 *    a different host from the API entirely (an internal Docker name, a private
 *    subnet, a managed database on another provider).
 * 2. A Cloud project ref plus a password, where the host is derivable.
 * 3. Nothing — no Postgres transport.
 */
export function buildPostgresConfig(creds: SupabaseCredentials): ClientConfig | null {
  const connection = creds.database;

  if (connection !== undefined) {
    const resolved = resolveConnection(connection);
    if (resolved === null) return null;

    const password = resolvePassword(connection);

    const config: ClientConfig = {
      host: resolved.host,
      port: resolved.port,
      user: resolved.username,
      password,
      database: resolved.database,
      ssl: sslConfig(resolved.ssl),
      connectionTimeoutMillis: connection.connectionTimeoutMs,
    };

    // A transaction-mode pooler multiplexes many clients onto few backends, so it
    // cannot keep a prepared statement (or any session state) between round-trips.
    // `pg` uses the extended query protocol by default, which would break.
    if (isSessionless(connection.poolerMode)) {
      config.statement_timeout = undefined;
      config.query_timeout = undefined;
    }

    return config;
  }

  // Cloud shorthand: the ref gives us the host, so the password is all we need.
  if (creds.dbPassword === undefined || creds.dbPassword === '') return null;

  const ref = parseProjectRef(creds.url);
  if (ref !== null) {
    // Note this direct host is IPv6-only for projects without the IPv4 add-on —
    // which is exactly why the Management API transport is tried first on Cloud.
    return {
      host: `db.${ref}.supabase.co`,
      port: 5432,
      user: 'postgres',
      password: creds.dbPassword,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
    };
  }

  // A self-hosted instance with only a password: guess that Postgres shares Kong's
  // host on the default port. Often right for a simple Docker deployment, and the
  // Database Connection panel exists for when it is not.
  let host: string;
  try {
    host = new URL(normaliseUrl(creds.url)).hostname;
  } catch {
    return null;
  }

  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return {
    host,
    port: 5432,
    user: 'postgres',
    password: creds.dbPassword,
    database: 'postgres',
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap SQL for the RPC transport
// ---------------------------------------------------------------------------

/**
 * SQL that installs the two helper functions the RPC transport needs.
 *
 * Shown verbatim in the UI so a user whose self-hosted instance has no reachable
 * Postgres port can paste it into their SQL editor and unlock the RPC transport.
 */
export const EXEC_HELPER_SQL = `
-- Nebkern Migration Tool: SQL execution helpers.
-- These grant full database access to any caller, so they are restricted to the
-- service_role and should be dropped once your migration finishes.

create or replace function public.${EXEC_SQL_FUNCTION}(query text)
returns jsonb
language plpgsql
security definer
as $nebkern$
declare
  result jsonb;
begin
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query) into result;
  return result;
end;
$nebkern$;

create or replace function public.${EXEC_SQL_FUNCTION}_ddl(query text)
returns void
language plpgsql
security definer
as $nebkern$
begin
  execute query;
end;
$nebkern$;

revoke all on function public.${EXEC_SQL_FUNCTION}(text) from public, anon, authenticated;
revoke all on function public.${EXEC_SQL_FUNCTION}_ddl(text) from public, anon, authenticated;
grant execute on function public.${EXEC_SQL_FUNCTION}(text) to service_role;
grant execute on function public.${EXEC_SQL_FUNCTION}_ddl(text) to service_role;
`.trim();

/** Removes the helpers. Offered as a post-migration cleanup action. */
export const DROP_EXEC_HELPER_SQL = `
drop function if exists public.${EXEC_SQL_FUNCTION}(text);
drop function if exists public.${EXEC_SQL_FUNCTION}_ddl(text);
`.trim();

export async function installExecHelpers(transport: SqlTransport): Promise<void> {
  await transport.execute(EXEC_HELPER_SQL);
}

export async function dropExecHelpers(transport: SqlTransport): Promise<void> {
  await transport.execute(DROP_EXEC_HELPER_SQL);
}

// ---------------------------------------------------------------------------
// Probing & factory
// ---------------------------------------------------------------------------

/** A cheap round-trip that proves the transport can actually run SQL. */
async function probe(transport: SqlTransport): Promise<void> {
  const result = await transport.query<{ ok: number }>('select 1 as ok');
  if (result.rows.length !== 1) {
    throw new MigrationError('CONNECTION_FAILED', `${transport.kind}: probe query returned no rows`);
  }
}

export interface TransportProbe {
  readonly kind: TransportKind;
  readonly available: boolean;
  readonly reason?: string;
  readonly transport: SqlTransport | null;
}

/**
 * Tries each transport in order of preference and reports what worked.
 *
 * The order is not arbitrary. Management API first because on Cloud it is the
 * only one that needs no database password and no direct socket. Postgres second
 * because when it *is* reachable it is the fastest and the only one with real
 * bind parameters. RPC last because it depends on a helper function that may not
 * be installed yet.
 */
export async function probeTransports(creds: SupabaseCredentials): Promise<readonly TransportProbe[]> {
  const results: TransportProbe[] = [];
  const url = normaliseUrl(creds.url);
  const ref = parseProjectRef(url);

  // 1. Management API
  if (ref !== null && creds.accessToken !== undefined && creds.accessToken !== '') {
    const transport = new ManagementApiTransport(ref, creds.accessToken);
    try {
      await probe(transport);
      results.push({ kind: 'management_api', available: true, transport });
    } catch (err) {
      results.push({
        kind: 'management_api',
        available: false,
        reason: toMigrationError(err).message,
        transport: null,
      });
    }
  } else {
    results.push({
      kind: 'management_api',
      available: false,
      reason:
        ref === null
          ? 'Not a Supabase Cloud project — the Management API only exists for hosted projects'
          : 'No Personal Access Token supplied',
      transport: null,
    });
  }

  // 2. Direct Postgres
  const pgConfig = buildPostgresConfig(creds);
  if (pgConfig !== null) {
    const sessionless = creds.database !== undefined && isSessionless(creds.database.poolerMode);
    const transport = new PostgresTransport(pgConfig, sessionless);
    try {
      await probe(transport);
      results.push({ kind: 'postgres', available: true, transport });
    } catch (err) {
      await transport.dispose();
      results.push({ kind: 'postgres', available: false, reason: toMigrationError(err).message, transport: null });
    }
  } else {
    results.push({
      kind: 'postgres',
      available: false,
      reason: 'No database connection configured',
      transport: null,
    });
  }

  // 3. RPC helper
  const rpc = new RpcTransport(url, creds.serviceRoleKey);
  try {
    await probe(rpc);
    results.push({ kind: 'rpc', available: true, transport: rpc });
  } catch (err) {
    const error = toMigrationError(err);
    results.push({
      kind: 'rpc',
      available: false,
      reason:
        error.code === 'NOT_FOUND'
          ? `Helper function ${EXEC_SQL_FUNCTION} is not installed on this project`
          : error.message,
      transport: null,
    });
  }

  return results;
}

/** Preference order used when several transports are available. */
const PREFERENCE: readonly TransportKind[] = ['management_api', 'postgres', 'rpc'];

/**
 * Establishes the best available transport, disposing the runners-up.
 *
 * @throws {MigrationError} `NO_TRANSPORT` with a per-transport explanation of why
 * each one failed — the message the user actually needs in order to fix it.
 */
export async function connectTransport(creds: SupabaseCredentials): Promise<SqlTransport> {
  const probes = await probeTransports(creds);

  let chosen: SqlTransport | null = null;
  for (const kind of PREFERENCE) {
    const match = probes.find((p) => p.kind === kind && p.available && p.transport !== null);
    if (match?.transport) {
      chosen = match.transport;
      break;
    }
  }

  // Release the connections we are not going to use.
  for (const probeResult of probes) {
    if (probeResult.transport !== null && probeResult.transport !== chosen) {
      await probeResult.transport.dispose();
    }
  }

  if (chosen === null) {
    const reasons = probes.map((p) => `  • ${p.kind}: ${p.reason ?? 'unavailable'}`).join('\n');
    throw new MigrationError(
      'NO_TRANSPORT',
      `No way to run SQL against ${creds.url}. Supply a Personal Access Token (Cloud), a database password, or install the SQL helper function.\n${reasons}`,
      { detail: reasons },
    );
  }

  return chosen;
}

export { ManagementApiTransport, RpcTransport, PostgresTransport };
