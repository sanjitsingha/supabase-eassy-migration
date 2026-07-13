/**
 * @file Verifies the self-hosted connection layer.
 *
 * Three things are tested, and each of them is a place where a plausible-looking
 * implementation is quietly wrong:
 *
 * 1. **Connection-string parsing.** The naive approach (`new URL()`) mis-splits any
 *    password containing `@` — which generated passwords very often do — producing a
 *    garbled hostname and a "could not resolve host" error that points the user at
 *    entirely the wrong thing.
 * 2. **Round-tripping.** The form keeps a pasted string and the manual fields in sync.
 *    If parse → build → parse is not a fixed point, switching modes silently corrupts
 *    the user's credentials.
 * 3. **Pooler detection.** Recognising Supavisor *before* dialling it is what lets us
 *    explain `ENOIDENTIFIER` instead of just reporting it.
 *
 * Run with: npx tsx scripts/verify-connection.ts
 */

import { buildConnectionString, detectPooler, emptyConnection, parseConnectionString, resolveConnection } from '../src/core/transport/postgres-url';
import { inspectKey } from '../src/core/transport/jwt';
import type { DatabaseConnection } from '../src/core/domain/types';

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  [32m✓[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  [31m✗[0m ${label}${detail !== '' ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

console.log('[1m[36mNebkern — self-hosted connection layer verification[0m');

// ---------------------------------------------------------------------------
section('1. Connection-string parsing');

const simple = parseConnectionString('postgresql://postgres:secret@db.example.com:5432/postgres');
check(
  'parses a standard connection string',
  simple.ok &&
    simple.host === 'db.example.com' &&
    simple.port === 5432 &&
    simple.username === 'postgres' &&
    simple.password === 'secret' &&
    simple.database === 'postgres',
  JSON.stringify(simple),
);

// The case that breaks `new URL()`: an unencoded `@` inside the password. A parser
// that splits on the FIRST `@` reads the host as "p4ss" and the user gets a DNS error.
const atSign = parseConnectionString('postgresql://postgres:p@ss/w0rd@10.0.0.5:5432/postgres');
check(
  'a password containing @ does not corrupt the host',
  atSign.ok && atSign.host === '10.0.0.5' && atSign.password === 'p@ss/w0rd',
  `host=${atSign.host} password=${atSign.password}`,
);

const encoded = parseConnectionString('postgresql://postgres:p%40ssw0rd@host:5432/postgres');
check('percent-encoded passwords are decoded', encoded.ok && encoded.password === 'p@ssw0rd', encoded.password);

const internal = parseConnectionString('postgres://postgres:pw@supabase-db:5432/postgres');
check(
  'the postgres:// scheme and a Docker-internal hostname both work',
  internal.ok && internal.host === 'supabase-db',
  internal.host,
);

const defaults = parseConnectionString('postgresql://myhost');
check(
  'missing components fall back to Postgres defaults',
  defaults.ok &&
    defaults.host === 'myhost' &&
    defaults.port === 5432 &&
    defaults.database === 'postgres' &&
    defaults.username === 'postgres',
  JSON.stringify(defaults),
);

const ipv6 = parseConnectionString('postgresql://postgres:pw@[2001:db8::1]:5432/postgres');
check('an IPv6 literal parses and keeps its port', ipv6.ok && ipv6.host === '2001:db8::1' && ipv6.port === 5432, `${ipv6.host}:${ipv6.port}`);

const sslmode = parseConnectionString('postgresql://postgres:pw@host:5432/postgres?sslmode=require');
check('sslmode is read from the query string', sslmode.ok && sslmode.ssl === 'require', String(sslmode.ssl));

const k8s = parseConnectionString('postgresql://postgres:pw@supabase-db.default.svc.cluster.local:5432/postgres');
check(
  'a Kubernetes service DNS name parses',
  k8s.ok && k8s.host === 'supabase-db.default.svc.cluster.local',
  k8s.host,
);

const noScheme = parseConnectionString('postgres:pw@host:5432/db');
check('a string without a scheme is rejected with a message', !noScheme.ok && noScheme.error !== null, String(noScheme.error));

const badPort = parseConnectionString('postgresql://postgres:pw@host:abc/postgres');
check('a non-numeric port is rejected', !badPort.ok, String(badPort.error));

// ---------------------------------------------------------------------------
section('2. Round-trip (the form keeps both representations in sync)');

const roundTripCases: readonly string[] = [
  'postgresql://postgres:secret@db.example.com:5432/postgres',
  'postgresql://postgres:p@ss w0rd!@10.0.0.5:6543/postgres',
  'postgresql://admin:x%23y@supabase-db:5432/app',
];

for (const original of roundTripCases) {
  const parsed = parseConnectionString(original);
  const connection: DatabaseConnection = {
    ...emptyConnection('manual'),
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    username: parsed.username,
    password: parsed.password,
  };
  const rebuilt = buildConnectionString(connection);
  const reparsed = parseConnectionString(rebuilt);

  check(
    `parse → build → parse is a fixed point for a password like "${parsed.password.slice(0, 8)}…"`,
    reparsed.ok &&
      reparsed.host === parsed.host &&
      reparsed.port === parsed.port &&
      reparsed.username === parsed.username &&
      reparsed.password === parsed.password &&
      reparsed.database === parsed.database,
    `original=${original}\n      rebuilt =${rebuilt}\n      password: "${parsed.password}" -> "${reparsed.password}"`,
  );
}

// ---------------------------------------------------------------------------
section('3. Resolution across both input modes');

const viaString: DatabaseConnection = {
  ...emptyConnection('connection_string'),
  connectionString: 'postgresql://postgres:pw@supabase-db:5432/postgres',
};
const resolvedString = resolveConnection(viaString);
check(
  'connection-string mode resolves to concrete fields',
  resolvedString?.host === 'supabase-db' && resolvedString.port === 5432,
  JSON.stringify(resolvedString),
);

const viaManual: DatabaseConnection = { ...emptyConnection('manual'), host: '192.168.1.10', port: 5432 };
const resolvedManual = resolveConnection(viaManual);
check(
  'manual mode fills in database and username defaults',
  resolvedManual?.database === 'postgres' && resolvedManual.username === 'postgres',
  JSON.stringify(resolvedManual),
);

check('an empty connection resolves to null rather than a bogus target', resolveConnection(emptyConnection()) === null);

// ---------------------------------------------------------------------------
section('4. Pooler detection (so ENOIDENTIFIER can be explained, not just reported)');

check(
  "Supabase's hosted pooler hostname is recognised",
  detectPooler({ host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432, database: 'postgres', username: 'postgres', ssl: 'prefer' }) === 'supavisor',
);

check(
  'port 6543 is recognised as Supavisor',
  detectPooler({ host: 'db.example.com', port: 6543, database: 'postgres', username: 'postgres', ssl: 'prefer' }) === 'supavisor',
);

check(
  'a tenant-qualified username is recognised as Supavisor',
  detectPooler({ host: 'db.example.com', port: 5432, database: 'postgres', username: 'postgres.abcdefghijklmnopqrst', ssl: 'prefer' }) === 'supavisor',
);

check(
  'port 6432 is recognised as PgBouncer',
  detectPooler({ host: 'db.example.com', port: 6432, database: 'postgres', username: 'postgres', ssl: 'prefer' }) === 'pgbouncer',
);

check(
  'a direct connection is not flagged as a pooler',
  detectPooler({ host: 'supabase-db', port: 5432, database: 'postgres', username: 'postgres', ssl: 'prefer' }) === null,
);

// ---------------------------------------------------------------------------
section('5. Service role key inspection');

/** Builds an unsigned JWT with the given claims. Signature is irrelevant — we decode, not verify. */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const future = Math.floor(Date.now() / 1000) + 86_400;

const serviceKey = inspectKey(makeJwt({ role: 'service_role', ref: 'abcdefghijklmnopqrst', exp: future }));
check(
  'a service role key is accepted',
  serviceKey.role === 'service_role' && serviceKey.errors.length === 0 && serviceKey.ref === 'abcdefghijklmnopqrst',
  JSON.stringify(serviceKey),
);

// The headline case: an anon key authenticates fine but is subject to RLS, so a
// migration would read almost nothing and appear to "succeed" with an empty database.
const anonKey = inspectKey(makeJwt({ role: 'anon', exp: future }));
check(
  'the anon key is REJECTED, not silently accepted',
  anonKey.role === 'anon' && anonKey.errors.length > 0,
  JSON.stringify(anonKey.errors),
);

const expiredKey = inspectKey(makeJwt({ role: 'service_role', exp: Math.floor(Date.now() / 1000) - 10 }));
check('an expired key is rejected', expiredKey.expired && expiredKey.errors.length > 0);

const secretKey = inspectKey('sb_secret_abcdef123456');
check('a new-style sb_secret_ key is accepted as opaque', secretKey.opaque && secretKey.errors.length === 0);

const publishable = inspectKey('sb_publishable_abcdef123456');
check('a publishable key is rejected', publishable.errors.length > 0, JSON.stringify(publishable.errors));

const garbage = inspectKey('not-a-key');
check('garbage is rejected with a useful message', garbage.errors.length > 0, String(garbage.errors[0]));

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(64)}`);
const colour = failures === 0 ? '[32m' : '[31m';
console.log(`${colour}${passes} passed, ${failures} failed[0m`);
process.exit(failures === 0 ? 0 : 1);
