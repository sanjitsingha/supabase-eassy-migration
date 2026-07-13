/**
 * @file Postgres connection strings: parse, build, and recognise what is on the
 * other end.
 *
 * Parsing is bidirectional and lossless enough to round-trip, because the UI keeps a
 * pasted URL and the individual fields in sync: paste a string and the fields fill;
 * edit a field and the string is rebuilt. Different hosts hand you different things —
 * Railway and Coolify give you a URL, a Docker Compose or Kubernetes setup gives you
 * an internal hostname and leaves you to fill in the rest — so neither form can be
 * the only one on offer.
 *
 * `new URL()` alone is not enough. A Postgres password is very often a raw paste from
 * a `.env` and contains `@`, `/`, `#` or `?` unencoded, which makes the URL parser
 * either throw or — much worse — silently mis-split the host. So we locate the *last*
 * `@` (the authority separator) by hand before parsing, which is the one
 * interpretation that cannot be ambiguous.
 */

import type { DatabaseConnection, PoolerMode, ResolvedConnection, SslMode } from '@/core/domain/types';

export interface ParsedConnectionString {
  readonly ok: boolean;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly ssl: SslMode | null;
  readonly error: string | null;
}

const DEFAULT_PORT = 5432;
const DEFAULT_DATABASE = 'postgres';
const DEFAULT_USERNAME = 'postgres';

/**
 * Parses `postgresql://user:pass@host:5432/db?sslmode=require`.
 *
 * Tolerant by design: every component has a sensible Postgres default, so a user who
 * pastes `postgresql://host` still gets a usable result rather than an error.
 */
export function parseConnectionString(raw: string): ParsedConnectionString {
  const input = raw.trim();

  const fail = (error: string): ParsedConnectionString => ({
    ok: false,
    host: '',
    port: DEFAULT_PORT,
    database: DEFAULT_DATABASE,
    username: DEFAULT_USERNAME,
    password: '',
    ssl: null,
    error,
  });

  if (input === '') return fail('Enter a connection string.');

  const schemeMatch = /^(postgresql|postgres):\/\//i.exec(input);
  if (!schemeMatch) {
    return fail('A connection string must start with postgresql:// or postgres://');
  }

  let rest = input.slice(schemeMatch[0].length);

  // Split the query string off first; a password cannot contain `?` unescaped and
  // still be unambiguous, and `sslmode` is the only param we care about.
  let query = '';
  const queryIndex = rest.indexOf('?');
  if (queryIndex !== -1) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  // The LAST `@` separates userinfo from the host. Using the first would break on
  // any password containing `@`, which is extremely common in generated passwords.
  let userInfo = '';
  let hostPart = rest;
  const atIndex = rest.lastIndexOf('@');
  if (atIndex !== -1) {
    userInfo = rest.slice(0, atIndex);
    hostPart = rest.slice(atIndex + 1);
  }

  // The FIRST `/` after the host begins the database name.
  let database = DEFAULT_DATABASE;
  const slashIndex = hostPart.indexOf('/');
  if (slashIndex !== -1) {
    const dbSegment = hostPart.slice(slashIndex + 1);
    hostPart = hostPart.slice(0, slashIndex);
    if (dbSegment !== '') database = safeDecode(dbSegment);
  }

  // Userinfo splits on the first `:` — a *username* containing `:` is not legal.
  let username = DEFAULT_USERNAME;
  let password = '';
  if (userInfo !== '') {
    const colonIndex = userInfo.indexOf(':');
    if (colonIndex === -1) {
      username = safeDecode(userInfo);
    } else {
      username = safeDecode(userInfo.slice(0, colonIndex));
      password = safeDecode(userInfo.slice(colonIndex + 1));
    }
  }

  // Host may be an IPv6 literal in brackets: [::1]:5432
  let host = hostPart;
  let port = DEFAULT_PORT;

  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']');
    if (close === -1) return fail('Unclosed IPv6 address in the host.');
    host = hostPart.slice(1, close);
    const after = hostPart.slice(close + 1);
    if (after.startsWith(':')) {
      const parsed = Number.parseInt(after.slice(1), 10);
      if (!Number.isFinite(parsed)) return fail('The port is not a number.');
      port = parsed;
    }
  } else {
    const colonIndex = hostPart.lastIndexOf(':');
    if (colonIndex !== -1) {
      const parsed = Number.parseInt(hostPart.slice(colonIndex + 1), 10);
      if (!Number.isFinite(parsed)) return fail('The port is not a number.');
      host = hostPart.slice(0, colonIndex);
      port = parsed;
    }
  }

  if (host === '') return fail('The connection string has no host.');
  if (port < 1 || port > 65535) return fail(`Port ${port} is out of range.`);

  let ssl: SslMode | null = null;
  if (query !== '') {
    const params = new URLSearchParams(query);
    const sslmode = params.get('sslmode');
    if (sslmode !== null) ssl = mapSslMode(sslmode);
  }

  return { ok: true, host, port, database, username, password, ssl, error: null };
}

/** Renders the manual fields back into a connection string. */
export function buildConnectionString(connection: DatabaseConnection): string {
  const host = connection.host ?? '';
  if (host === '') return '';

  const port = connection.port ?? DEFAULT_PORT;
  const database = connection.database ?? DEFAULT_DATABASE;
  const username = connection.username ?? DEFAULT_USERNAME;
  const password = connection.password ?? '';

  const auth =
    password === ''
      ? encodeURIComponent(username)
      : `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;

  // Bracket IPv6 literals, or the port would be unparseable.
  const hostPart = host.includes(':') ? `[${host}]` : host;
  const sslParam = connection.ssl === 'require' ? '?sslmode=require' : connection.ssl === 'disable' ? '?sslmode=disable' : '';

  return `postgresql://${auth}@${hostPart}:${port}/${encodeURIComponent(database)}${sslParam}`;
}

/** Collapses libpq's six sslmodes onto the four this tool distinguishes. */
function mapSslMode(value: string): SslMode {
  switch (value.toLowerCase()) {
    case 'disable':
      return 'disable';
    case 'allow':
    case 'prefer':
      return 'prefer';
    case 'require':
      return 'require';
    case 'verify-ca':
    case 'verify-full':
      return 'require';
    default:
      return 'prefer';
  }
}

/** `decodeURIComponent` that returns the input rather than throwing on a stray `%`. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Flattens either connection mode into the concrete values we will dial. */
export function resolveConnection(connection: DatabaseConnection): ResolvedConnection | null {
  if (connection.mode === 'connection_string') {
    const raw = connection.connectionString ?? '';
    if (raw.trim() === '') return null;

    const parsed = parseConnectionString(raw);
    if (!parsed.ok) return null;

    return {
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      username: parsed.username,
      // An explicit `sslmode` in the string beats the dropdown, since the user was
      // more specific.
      ssl: parsed.ssl ?? connection.ssl,
    };
  }

  const host = (connection.host ?? '').trim();
  if (host === '') return null;

  return {
    host,
    port: connection.port ?? DEFAULT_PORT,
    database: (connection.database ?? '').trim() === '' ? DEFAULT_DATABASE : (connection.database ?? DEFAULT_DATABASE),
    username: (connection.username ?? '').trim() === '' ? DEFAULT_USERNAME : (connection.username ?? DEFAULT_USERNAME),
    ssl: connection.ssl,
  };
}

/** The password, from whichever mode is active. */
export function resolvePassword(connection: DatabaseConnection): string {
  if (connection.mode === 'connection_string') {
    const parsed = parseConnectionString(connection.connectionString ?? '');
    return parsed.ok ? parsed.password : '';
  }
  return connection.password ?? '';
}

// ---------------------------------------------------------------------------
// Pooler recognition
// ---------------------------------------------------------------------------

/**
 * Recognises a pooler from the connection alone, before we dial it.
 *
 * Worth doing up-front because the failure mode is so unhelpful otherwise. Supavisor
 * encodes the tenant in the username (`postgres.<ref>`); connect with a bare
 * `postgres` and it rejects you with "no tenant identifier", which tells a user
 * nothing about what to do next. Catching it here lets us say so in plain words.
 */
export function detectPooler(resolved: ResolvedConnection): 'supavisor' | 'pgbouncer' | null {
  const host = resolved.host.toLowerCase();

  // Supabase's own hosted pooler.
  if (host.includes('pooler.supabase.com')) return 'supavisor';
  // Supavisor's transaction-mode port, whoever is running it.
  if (resolved.port === 6543) return 'supavisor';
  // A tenant-qualified username only means anything to Supavisor.
  if (/^postgres\.[a-z0-9]{16,}$/i.test(resolved.username)) return 'supavisor';
  // The conventional PgBouncer port.
  if (resolved.port === 6432) return 'pgbouncer';

  return null;
}

/**
 * A transaction-mode pooler cannot hold session state.
 *
 * The migration issues `SET statement_timeout`, `SET TIME ZONE` and similar on
 * connect, and a transaction pooler either rejects those or silently discards them
 * between statements. It also does not support prepared statements, which `pg` uses.
 * So this is the switch that tells the transport to stop assuming a session.
 */
export function isSessionless(mode: PoolerMode): boolean {
  return mode === 'transaction';
}

export const CONNECTION_DEFAULTS = {
  port: DEFAULT_PORT,
  database: DEFAULT_DATABASE,
  username: DEFAULT_USERNAME,
  ssl: 'prefer' as SslMode,
  poolerMode: 'direct' as PoolerMode,
  connectionTimeoutMs: 15_000,
} as const;

/** A blank connection with Postgres's own defaults already filled in. */
export function emptyConnection(mode: 'connection_string' | 'manual' = 'connection_string'): DatabaseConnection {
  return {
    mode,
    connectionString: '',
    host: '',
    port: CONNECTION_DEFAULTS.port,
    database: CONNECTION_DEFAULTS.database,
    username: CONNECTION_DEFAULTS.username,
    password: '',
    ssl: CONNECTION_DEFAULTS.ssl,
    poolerMode: CONNECTION_DEFAULTS.poolerMode,
    connectionTimeoutMs: CONNECTION_DEFAULTS.connectionTimeoutMs,
  };
}
