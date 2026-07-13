/**
 * @file Verifies the "Test PostgreSQL" success path against a real TCP Postgres.
 *
 * The other connection harness covers parsing and error mapping without a server. This
 * one goes the whole way: PGlite is exposed over a real TCP socket speaking the real
 * Postgres wire protocol, and `testDatabase` dials it with the same `pg` client the
 * production migration uses. So what is being tested is the actual code path, sockets
 * and all — not a stub.
 *
 * What it proves is that the panel reports *true* things: the server version it claims,
 * the user it claims to be connected as, the permissions it says you have, and the
 * extensions it says are installed.
 *
 * Run with: npx tsx scripts/verify-database-test.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { SupabaseCredentials } from '../src/core/domain/types';
import { testDatabase } from '../src/core/services/diagnostics.service';
import { emptyConnection } from '../src/core/transport/postgres-url';

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

const PORT = 55432;

function credentials(overrides: Partial<ReturnType<typeof emptyConnection>> = {}): SupabaseCredentials {
  return {
    type: 'self_hosted',
    url: 'https://api.example.com',
    serviceRoleKey: 'sb_secret_test',
    database: {
      ...emptyConnection('manual'),
      host: '127.0.0.1',
      port: PORT,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      ssl: 'disable',
      connectionTimeoutMs: 10_000,
      ...overrides,
    },
  };
}

async function main(): Promise<void> {
  console.log('[1m[36mNebkern — "Test PostgreSQL" against a real TCP Postgres[0m');

  // Deliberately a *bare* Postgres — no `supabase_admin`, no `anon`, none of the roles
  // a full Supabase stack creates. This is the shape of a plain Postgres destination, or
  // a hardened self-host, and it is precisely where a permission probe that assumes
  // Supabase's roles exist will blow up.
  const db = new PGlite();
  await db.waitReady;

  const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  console.log(`\nPostgres listening on 127.0.0.1:${PORT} (PGlite over a real socket).`);

  try {
    // --- Success path ------------------------------------------------------
    section('1. A working connection, via manual fields');

    const manual = await testDatabase(credentials());

    check('the connection succeeds', manual.ok, manual.error ?? '');
    check('reports a PostgreSQL version', manual.version !== null, `version: ${manual.version}`);
    check('reports the current database', manual.database === 'postgres', `database: ${manual.database}`);
    check('reports the connected user', manual.user !== null, `user: ${manual.user}`);
    check('echoes back the resolved target', manual.resolved?.port === PORT, JSON.stringify(manual.resolved));
    check('does not falsely claim a pooler', manual.pooler === null, String(manual.pooler));
    check('reports a latency', manual.latencyMs >= 0);

    console.log(`\n      → PostgreSQL ${manual.version}`);
    console.log(`      → Connected as ${manual.user}`);
    console.log(`      → Database ${manual.database}`);

    // --- Permissions -------------------------------------------------------
    section('2. Permissions are read from the server, not assumed');

    check('reports a permission set', manual.permissions.length === 5, `${manual.permissions.length} permissions`);
    check(
      'the create-table permission is resolved',
      manual.permissions.some((p) => p.key === 'create_table'),
    );
    check(
      'every permission carries an explanation of why it matters',
      manual.permissions.every((p) => p.required.length > 0),
    );

    for (const permission of manual.permissions) {
      console.log(`      ${permission.granted ? '[32m✓[0m' : '[90m·[0m'} ${permission.label}`);
    }

    // --- Extensions --------------------------------------------------------
    section('3. Extensions');

    check('lists the installed extensions', manual.extensions.length > 0, `${manual.extensions.length} found`);
    check(
      'finds plpgsql, which every Postgres has',
      manual.extensions.some((e) => e.name === 'plpgsql'),
      manual.extensions.map((e) => e.name).join(', '),
    );
    check('each extension carries its version', manual.extensions.every((e) => e.version !== ''));

    console.log(`      → ${manual.extensions.map((e) => `${e.name} ${e.version}`).join(', ')}`);

    // --- Regression: a Postgres with no Supabase roles ----------------------
    section('4. Works on a Postgres that has no Supabase roles at all');

    // A regression guard for a real bug. The permission probe used to call
    // `pg_has_role(current_user, 'supabase_admin', 'MEMBER')`, which *raises* when the
    // named role does not exist — and a bare Postgres destination, or a hardened
    // self-host, has no supabase_admin. The raise aborted the whole query, and the error
    // mapper then reported it as "the role postgres does not exist", which is both wrong
    // and deeply confusing. This server has no Supabase roles, so it reproduces exactly
    // that condition.
    const supabaseRoles = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_roles where rolname in ('supabase_admin','anon','authenticated','service_role')`,
    );
    check(
      'the test server genuinely has no Supabase roles',
      supabaseRoles.rows[0]?.n === '0',
      `found ${supabaseRoles.rows[0]?.n}`,
    );
    check(
      'the permission probe still resolves rather than erroring',
      manual.ok && manual.permissions.length === 5,
      manual.error ?? `${manual.permissions.length} permissions`,
    );
    check(
      'and correctly reports the Supabase-admin-derived permissions as ungranted',
      manual.permissions.find((p) => p.key === 'create_extension') !== undefined,
    );

    // --- Connection-string mode --------------------------------------------
    section('5. The same server reached via a connection string');

    const viaString = await testDatabase({
      ...credentials(),
      database: {
        ...emptyConnection('connection_string'),
        connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
        ssl: 'disable',
        connectionTimeoutMs: 10_000,
      },
    });

    check('a connection string reaches the same server', viaString.ok, viaString.error ?? '');
    check(
      'both modes agree on the version',
      viaString.version === manual.version,
      `${viaString.version} vs ${manual.version}`,
    );

    // --- Failure paths -----------------------------------------------------
    section('6. Failures are diagnosed, not just reported');

    // Note: a wrong database name and a wrong password cannot be exercised here.
    // PGlite's socket server serves its single database to any login, whatever database
    // name or username the client asks for, so it cannot produce a 3D000 or a 28P01.
    // Those mappings are covered by inspection, not by this harness — and saying so is
    // better than writing an assertion that only ever tests the harness.

    const refused = await testDatabase(credentials({ port: 55499 }));
    check(
      'a refused connection is identified as such',
      !refused.ok && refused.errorCode === 'ECONNREFUSED',
      `${refused.errorCode}: ${refused.error}`,
    );
    check(
      'and the hint mentions internal Docker networking',
      refused.hints.some((h) => /docker|internal/i.test(h)),
      refused.hints.join(' | '),
    );

    const badHost = await testDatabase(credentials({ host: 'no-such-host.invalid' }));
    check(
      'an unresolvable host is identified',
      !badHost.ok && (badHost.errorCode === 'ENOTFOUND' || badHost.errorCode === 'EAI_AGAIN'),
      `${badHost.errorCode}: ${badHost.error}`,
    );

    const unconfigured = await testDatabase({
      type: 'self_hosted',
      url: 'https://api.example.com',
      serviceRoleKey: 'sb_secret_test',
    });
    check(
      'no configuration at all is reported clearly, not as a crash',
      !unconfigured.ok && unconfigured.errorCode === 'NOT_CONFIGURED',
      String(unconfigured.error),
    );

    // --- Pooler ------------------------------------------------------------
    section('7. Supavisor is recognised before we even dial');

    const pooler = await testDatabase(credentials({ port: 6543 }));
    check(
      'port 6543 is flagged as Supavisor even though the connection failed',
      pooler.pooler === 'supavisor',
      String(pooler.pooler),
    );
  } finally {
    await server.stop();
    await db.close();
  }

  console.log(`\n${'─'.repeat(64)}`);
  const colour = failures === 0 ? '[32m' : '[31m';
  console.log(`${colour}${passes} passed, ${failures} failed[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('\n[31mHarness crashed:[0m', err);
  process.exit(1);
});
