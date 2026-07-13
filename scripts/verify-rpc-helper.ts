/**
 * @file Verifies the SQL helper (RPC) channel — SQL over the API, no database port.
 *
 * This is the escape hatch for self-hosted deployments where Postgres is bound to the
 * internal Docker/Kubernetes network and port 5432 is not reachable. It matters that the
 * helper functions are *exactly right*, because a user is going to paste them into their
 * production database on our say-so.
 *
 * So this runs the real `EXEC_HELPER_SQL` — the same string the UI tells the user to
 * copy — against a real Postgres (PGlite/WASM), and then proves the two things that
 * actually decide whether the migration works through it:
 *
 *   1. `nebkern_exec_sql` returns rows as JSON, so introspection can read the catalog.
 *   2. `nebkern_exec_sql_ddl` executes statements that return nothing, so DDL can be
 *      applied.
 *
 * It also checks the grants, because these are `security definer` functions that execute
 * arbitrary SQL — if `anon` could reach them, every project that installed them would be
 * trivially compromised by anyone holding the public frontend key.
 *
 * Run with: npx tsx scripts/verify-rpc-helper.ts
 */

import { createServer, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { EXEC_HELPER_SQL, DROP_EXEC_HELPER_SQL } from '../src/core/transport/exec-helper';
import { RpcTransport } from '../src/core/transport/transports';

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== '' ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main(): Promise<void> {
  console.log('\x1b[1m\x1b[36mNebkern — SQL helper (RPC) channel\x1b[0m');
  console.log('Runs the exact bootstrap SQL the UI hands the user, against real Postgres.\n');

  const db = new PGlite();
  await db.waitReady;

  // Supabase's roles. A bare Postgres has none of them, and the helper SQL grants to
  // service_role and revokes from anon/authenticated — so it must have them to run.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
  `);

  // --- Install -------------------------------------------------------------
  section('1. The bootstrap SQL installs cleanly');

  let installError: string | null = null;
  try {
    await db.exec(EXEC_HELPER_SQL);
  } catch (err) {
    installError = err instanceof Error ? err.message : String(err);
  }
  check('EXEC_HELPER_SQL runs without error', installError === null, installError ?? '');

  const functions = await db.query<{ name: string }>(`
    select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'nebkern_exec_sql%'
    order by p.proname
  `);
  check(
    'both helper functions exist',
    functions.rows.length === 2,
    functions.rows.map((r) => r.name).join(', '),
  );

  const definer = await db.query<{ n: string }>(`
    select count(*)::text as n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'nebkern_exec_sql%' and p.prosecdef
  `);
  check('both are SECURITY DEFINER (required to read the catalog)', definer.rows[0]?.n === '2');

  // --- Query channel -------------------------------------------------------
  section('2. nebkern_exec_sql carries SELECTs (this is how the schema is read)');

  await db.exec(`
    create table public.widgets (id bigserial primary key, name text not null, price numeric(12,4));
    insert into public.widgets (name, price) values ('bolt', 1.2345), ('nut', 9.8765);
  `);

  const selectResult = await db.query<{ result: unknown }>(
    `select public.nebkern_exec_sql('select id, name, price from public.widgets order by id') as result`,
  );
  const rows = selectResult.rows[0]?.result as { id: number; name: string; price: string }[] | null;

  check('a SELECT returns rows as JSON', Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
  check('column values survive', rows?.[0]?.name === 'bolt' && rows?.[1]?.name === 'nut', JSON.stringify(rows));

  // The catalog query is the whole point — introspection must work through this pipe.
  const catalog = await db.query<{ result: unknown }>(
    `select public.nebkern_exec_sql('select table_name from information_schema.tables where table_schema = ''public'' order by table_name') as result`,
  );
  const tables = catalog.rows[0]?.result as { table_name: string }[] | null;
  check(
    'a pg_catalog / information_schema query works (schema introspection)',
    Array.isArray(tables) && tables.some((t) => t.table_name === 'widgets'),
    JSON.stringify(tables),
  );

  // An empty result must be an empty array, not null — the transport parses it as rows.
  const emptyResult = await db.query<{ result: unknown }>(
    `select public.nebkern_exec_sql('select 1 where false') as result`,
  );
  check(
    'an empty result set comes back as [] rather than null',
    Array.isArray(emptyResult.rows[0]?.result) && (emptyResult.rows[0]?.result as unknown[]).length === 0,
    JSON.stringify(emptyResult.rows[0]?.result),
  );

  // --- DDL channel ---------------------------------------------------------
  section('3. nebkern_exec_sql_ddl carries DDL (this is how the schema is written)');

  let ddlError: string | null = null;
  try {
    await db.exec(`select public.nebkern_exec_sql_ddl('create table public.gadgets (id int primary key, label text)')`);
  } catch (err) {
    ddlError = err instanceof Error ? err.message : String(err);
  }
  check('CREATE TABLE executes through the DDL helper', ddlError === null, ddlError ?? '');

  const created = await db.query<{ n: string }>(
    `select count(*)::text as n from pg_class where relname = 'gadgets' and relkind = 'r'`,
  );
  check('the table really exists afterwards', created.rows[0]?.n === '1');

  // Data must move through it too, or the copy stage cannot work.
  await db.exec(
    `select public.nebkern_exec_sql_ddl('insert into public.gadgets (id, label) values (1, ''alpha''), (2, ''beta'')')`,
  );
  const inserted = await db.query<{ n: string }>(`select count(*)::text as n from public.gadgets`);
  check('INSERT executes through the DDL helper (the data copy path)', inserted.rows[0]?.n === '2');

  // --- Security ------------------------------------------------------------
  section('4. Security — these execute arbitrary SQL, so the grants must be exactly right');

  const grants = await db.query<{ grantee: string }>(`
    select distinct g.grantee
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    cross join lateral (select pg_get_userbyid(a.grantee) as grantee) g
    where n.nspname = 'public' and p.proname like 'nebkern_exec_sql%'
    order by g.grantee
  `);
  const grantees = grants.rows.map((r) => r.grantee);

  check('service_role can execute', grantees.includes('service_role'), grantees.join(', '));

  // The one that matters. `anon` is the PUBLIC key baked into every frontend — if it
  // could call a security-definer function that runs arbitrary SQL, installing this
  // helper would hand the whole database to anyone who viewed the page source.
  check(
    'anon CANNOT execute (the anon key is public — this must never be reachable)',
    !grantees.includes('anon'),
    `grantees: ${grantees.join(', ')}`,
  );
  check(
    'authenticated CANNOT execute',
    !grantees.includes('authenticated'),
    `grantees: ${grantees.join(', ')}`,
  );
  check(
    'PUBLIC cannot execute',
    !grantees.includes('public') && !grantees.includes('PUBLIC'),
    `grantees: ${grantees.join(', ')}`,
  );

  // --- Idempotency & teardown ---------------------------------------------
  section('5. Re-running and cleanup');

  let rerunError: string | null = null;
  try {
    await db.exec(EXEC_HELPER_SQL);
  } catch (err) {
    rerunError = err instanceof Error ? err.message : String(err);
  }
  check('re-running the bootstrap SQL is idempotent (create or replace)', rerunError === null, rerunError ?? '');

  await db.exec(DROP_EXEC_HELPER_SQL);
  const afterDrop = await db.query<{ n: string }>(`
    select count(*)::text as n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'nebkern_exec_sql%'
  `);
  check('DROP_EXEC_HELPER_SQL removes both functions', afterDrop.rows[0]?.n === '0', `${afterDrop.rows[0]?.n} left`);

  // --- The transport, over real HTTP ---------------------------------------
  section('6. RpcTransport over HTTP, against PostgREST’s real response shapes');

  // Reinstall — section 5 dropped them.
  await db.exec(EXEC_HELPER_SQL);

  /**
   * A stand-in for PostgREST.
   *
   * The one behaviour that matters, and that testing the SQL functions directly could
   * never surface: a plpgsql function returning `void` makes PostgREST answer
   * **204 No Content with an empty body**. An earlier version of `RpcTransport.execute`
   * called `.json()` on that, which throws `Unexpected end of JSON input` — *after* the
   * statement had already executed. Every applied DDL statement was reported as a
   * failure while having actually succeeded. This server reproduces that exactly.
   */
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      void (async () => {
        const isDdl = req.url?.includes('_ddl') === true;
        const { query } = JSON.parse(body) as { query: string };

        try {
          if (isDdl) {
            await db.query(`select public.nebkern_exec_sql_ddl($1)`, [query]);
            // PostgREST's response for a void-returning function.
            res.writeHead(204).end();
          } else {
            const result = await db.query<{ r: unknown }>(`select public.nebkern_exec_sql($1) as r`, [query]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows[0]?.r ?? []));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(54321, '127.0.0.1', resolve));
  const transport = new RpcTransport('http://127.0.0.1:54321', 'sb_secret_test');

  try {
    const selected = await transport.query<{ name: string }>('select name from public.widgets order by id');
    check(
      'query() reads rows over HTTP',
      selected.rows.length === 2 && selected.rows[0]?.name === 'bolt',
      JSON.stringify(selected.rows),
    );

    // THE regression. This threw "Unexpected end of JSON input" before the fix, despite
    // the CREATE TABLE having succeeded on the server.
    let executeError: string | null = null;
    try {
      await transport.execute(`create table public.rpc_over_http (id int primary key)`);
    } catch (err) {
      executeError = err instanceof Error ? err.message : String(err);
    }
    check(
      'execute() survives a 204 empty body (the "Unexpected end of JSON input" bug)',
      executeError === null,
      executeError ?? '',
    );

    const madeIt = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_class where relname = 'rpc_over_http'`,
    );
    check('and the DDL really was applied', madeIt.rows[0]?.n === '1');

    const emptySelect = await transport.query('select 1 where false');
    check('an empty result set yields zero rows, not a parse error', emptySelect.rows.length === 0);

    // A genuine SQL error must still surface as an error, not be swallowed by the
    // more-forgiving body handling.
    let sqlError = false;
    try {
      await transport.execute('this is not valid sql');
    } catch {
      sqlError = true;
    }
    check('a genuinely invalid statement still raises', sqlError);
  } finally {
    await transport.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await db.close();

  console.log(`\n${'─'.repeat(64)}`);
  const colour = failures === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`${colour}${passes} passed, ${failures} failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('\n\x1b[31mHarness crashed:\x1b[0m', err);
  process.exit(1);
});
