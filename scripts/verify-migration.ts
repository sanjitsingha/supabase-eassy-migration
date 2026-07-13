/**
 * @file End-to-end verification of the migration engine against a real Postgres.
 *
 * PGlite is genuine Postgres compiled to WebAssembly — a real planner, a real
 * `pg_catalog`, real type input/output functions. So this exercises the production
 * code paths (`IntrospectionRepository`, the DDL generator, `DataRepository`) rather
 * than mocking them, and a pass here means the SQL actually parses and executes on a
 * real engine.
 *
 * The fixture is deliberately nasty. It includes the things that break naive
 * migration tools:
 *
 *   - a non-public custom schema, to prove we do not only migrate `public`
 *   - an enum and a composite type used as column types
 *   - a `numeric(30,10)` money column, to prove precision survives (the bug you get
 *     from round-tripping rows through `JSON.parse`)
 *   - `bytea`, `jsonb`, `text[]`, `timestamptz` columns
 *   - a `GENERATED ALWAYS AS ... STORED` column, which must never be written on insert
 *   - an `IDENTITY ALWAYS` column, which needs `OVERRIDING SYSTEM VALUE`
 *   - a **circular** foreign key pair (A→B and B→A), which no topological sort can order
 *   - a table with *no* primary key, which must fall back to ctid pagination
 *   - a partial index, a view over a view, a trigger, a function, and RLS policies
 *   - a sequence whose value must be carried across, or the first post-migration
 *     insert collides
 *
 * Run with: npx tsx scripts/verify-migration.ts
 */

import { PGlite } from '@electric-sql/pglite';
import type { SqlResult, SqlRow, SqlTransport } from '../src/core/domain/types';
import { IntrospectionRepository } from '../src/core/repositories/introspection.repository';
import { DataRepository } from '../src/core/repositories/data.repository';
import { buildPhases, POST_DATA_PHASES, PRE_DATA_PHASES } from '../src/core/ddl/generator';

/** A {@link SqlTransport} over PGlite, so the repositories run unmodified. */
class PGliteTransport implements SqlTransport {
  readonly kind = 'postgres' as const;
  readonly supportsTransactions = true;

  constructor(private readonly db: PGlite) {}

  async query<T extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    if (params.length > 0) {
      await this.db.query(sql, params as unknown[]);
    } else {
      // `exec` handles multi-statement bodies, which `do $$ ... $$` blocks need.
      await this.db.exec(sql);
    }
  }

  async dispose(): Promise<void> {
    await this.db.close();
  }
}

const SOURCE_FIXTURE = `
create schema analytics;

create type public.order_status as enum ('pending', 'paid', 'shipped', 'refunded');
create type public.address as (line1 text, city text, postcode text);

create sequence public.invoice_seq start with 1;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text,
  balance numeric(30,10) not null default 0,
  tags text[],
  profile jsonb,
  avatar bytea,
  shipping public.address,
  created_at timestamptz not null default now(),
  -- Generated: must be recreated as generated, and never written on insert.
  email_domain text generated always as (split_part(email, '@', 2)) stored,
  -- Circular FK: customers -> orders, and orders -> customers.
  last_order_id bigint
);

create table public.orders (
  -- IDENTITY ALWAYS: inserting an explicit value needs OVERRIDING SYSTEM VALUE.
  id bigint generated always as identity primary key,
  customer_id uuid not null,
  status public.order_status not null default 'pending',
  total numeric(30,10) not null,
  invoice_no bigint not null default nextval('public.invoice_seq'),
  placed_at timestamptz not null default now()
);

alter table public.orders
  add constraint orders_customer_fk foreign key (customer_id) references public.customers(id) on delete cascade;
alter table public.customers
  add constraint customers_last_order_fk foreign key (last_order_id) references public.orders(id) on delete set null;

-- No primary key and no unique index: the copier must fall back to ctid ordering.
create table public.audit_log (
  action text not null,
  payload jsonb,
  at timestamptz not null default now()
);

-- A table in a non-public schema.
create table analytics.page_views (
  id bigserial primary key,
  path text not null,
  viewed_at timestamptz not null default now()
);

create index orders_status_idx on public.orders (status);
create index customers_email_lower_idx on public.customers (lower(email));
-- A partial index: pg_get_indexdef must carry the WHERE clause across.
create index orders_unpaid_idx on public.orders (customer_id) where status = 'pending';

create function public.touch_customer() returns trigger language plpgsql as $fn$
begin
  new.full_name := coalesce(new.full_name, 'anonymous');
  return new;
end;
$fn$;

create trigger customers_touch before insert on public.customers
  for each row execute function public.touch_customer();

create view public.paid_orders as
  select o.id, o.customer_id, o.total from public.orders o where o.status = 'paid';

-- A view over a view: must be created second, or it fails.
create view public.paid_order_totals as
  select customer_id, sum(total) as lifetime from public.paid_orders group by customer_id;

alter table public.customers enable row level security;
create policy customers_self_select on public.customers
  for select to public using (true);
create policy customers_self_update on public.customers
  for update to public using (email = current_user) with check (email = current_user);

comment on table public.customers is 'People who buy things';
comment on column public.customers.balance is 'Store credit, to 10dp';
`;

/** Rows chosen to catch precision loss, type mangling and encoding bugs. */
const SEED = `
insert into public.customers (id, email, full_name, balance, tags, profile, avatar, shipping)
values
  ('11111111-1111-1111-1111-111111111111', 'ada@example.com', 'Ada Lovelace',
   123456789012345678.1234567891, array['vip','early'], '{"tier":"gold","n":42}'::jsonb,
   decode('deadbeef','hex'), row('1 Analytical Way','London','E1 6AN')::public.address),
  ('22222222-2222-2222-2222-222222222222', 'alan@example.com', null,
   0.0000000001, array['beta'], '{"tier":"silver"}'::jsonb,
   decode('cafebabe','hex'), row('2 Bletchley Rd','Milton Keynes','MK3 6EB')::public.address),
  ('33333333-3333-3333-3333-333333333333', 'grace@example.com', 'Grace Hopper',
   -98765.4321, null, null, null, null);

insert into public.orders (customer_id, status, total)
select c.id, s.status, s.total
from public.customers c
cross join (values
  ('paid'::public.order_status, 199.9900000000::numeric(30,10)),
  ('pending'::public.order_status, 42.0000000001::numeric(30,10))
) as s(status, total);

update public.customers c
set last_order_id = (select min(o.id) from public.orders o where o.customer_id = c.id);

insert into public.audit_log (action, payload) values
  ('login', '{"ip":"10.0.0.1"}'::jsonb),
  ('logout', null),
  ('purchase', '{"amount":199.99}'::jsonb);

insert into analytics.page_views (path) values ('/'), ('/pricing'), ('/docs');
`;

// ---------------------------------------------------------------------------

let passes = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  [32m✓[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  [31m✗[0m ${label}${detail !== '' ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

async function main(): Promise<void> {
  console.log('[1m[36mNebkern migration engine — end-to-end verification[0m');
  console.log('Real Postgres (PGlite/WASM), real pg_catalog, production code paths.\n');

  const sourceDb = new PGlite();
  const destDb = new PGlite();
  const source = new PGliteTransport(sourceDb);
  const destination = new PGliteTransport(destDb);

  // --- Build the source ----------------------------------------------------
  await sourceDb.exec(SOURCE_FIXTURE);
  await sourceDb.exec(SEED);
  console.log('Source database built and seeded.');

  // --- Introspect ----------------------------------------------------------
  section('1. Introspection (pg_catalog → domain model)');

  const introspection = new IntrospectionRepository(source);
  const schemaNames = (await introspection.schemas()).map((s) => s.name);
  const schema = await introspection.introspect(schemaNames);

  check('discovers non-public schemas', schemaNames.includes('analytics'), `got: ${schemaNames.join(', ')}`);
  check('finds all 4 tables', schema.tables.length === 4, `got ${schema.tables.length}`);
  check('finds the enum + composite types', schema.types.length >= 2, `got ${schema.types.length}`);
  check('finds both views', schema.views.length === 2, `got ${schema.views.length}`);
  check('finds the function', schema.routines.some((r) => r.name === 'touch_customer'));
  check('finds the trigger', schema.triggers.some((t) => t.name === 'customers_touch'));
  check('finds both RLS policies', schema.policies.length === 2, `got ${schema.policies.length}`);

  const customers = schema.tables.find((t) => t.name === 'customers');
  check('detects the generated column', customers?.generatedColumns.includes('email_domain') === true);
  check('picks a copy key (primary key)', customers?.copyKey.join(',') === 'id', `got ${customers?.copyKey.join(',')}`);
  check('reads the table comment', customers?.comment === 'People who buy things');

  const auditLog = schema.tables.find((t) => t.name === 'audit_log');
  check('no-PK table has an empty copy key (ctid fallback)', auditLog?.copyKey.length === 0);

  const orders = schema.tables.find((t) => t.name === 'orders');
  check('detects IDENTITY ALWAYS', orders?.columns.find((c) => c.name === 'id')?.identity === 'ALWAYS');

  const partial = orders?.indexes.find((i) => i.name === 'orders_unpaid_idx');
  check('preserves the partial index predicate', partial?.definition.includes('WHERE') === true);

  const circular = schema.tables.flatMap((t) => t.constraints).filter((c) => c.kind === 'f');
  check('finds both sides of the circular FK', circular.length === 2, `got ${circular.length}`);

  // --- Generate and apply DDL ----------------------------------------------
  section('2. DDL generation and application to a fresh database');

  const phases = buildPhases(schema);
  const applied: Record<string, number> = {};
  const errors: string[] = [];

  // Pre-data phases ONLY. Foreign keys, indexes, views, triggers and policies
  // deliberately do not exist yet — that is the entire point of the pre/post split,
  // and this fixture proves why it is load-bearing rather than merely faster:
  // `customers` and `orders` reference each other, so with both FKs already in place
  // there is *no* order in which the two tables' rows could be inserted at all.
  for (const phase of PRE_DATA_PHASES) {
    const statements = phases.get(phase) ?? [];
    let ok = 0;

    for (const statement of statements) {
      try {
        await destination.execute(statement.sql);
        ok += 1;
      } catch (err) {
        errors.push(`[${phase}] ${statement.object}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    applied[phase] = ok;
    if (statements.length > 0) {
      const symbol = ok === statements.length ? '[32m✓[0m' : '[31m✗[0m';
      console.log(`  ${symbol} ${phase.padEnd(15)} ${ok}/${statements.length} statements`);
      if (ok === statements.length) passes += 1;
      else failures += 1;
    }
  }

  if (errors.length > 0) {
    console.log('\n  [31mDDL errors:[0m');
    for (const error of errors) console.log(`    ${error}`);
  }

  // --- Copy data -----------------------------------------------------------
  section('3. Data copy (keyset pagination, jsonb round-trip)');

  const sourceData = new DataRepository(source);
  const destData = new DataRepository(destination);
  const destTables = await new IntrospectionRepository(destination).tables(schemaNames);

  for (const table of schema.tables) {
    const target = destTables.find((t) => t.schema === table.schema && t.name === table.name);
    const plan = DataRepository.plan(table, target);

    if (plan === null) {
      check(`plan for ${table.schema}.${table.name}`, false, 'no copy plan could be built');
      continue;
    }

    let copied = 0;
    try {
      // Batch size of 2 forces multiple pages, so pagination is genuinely exercised
      // rather than every table fitting in one batch.
      for await (const batch of sourceData.readBatches(plan, 2, null)) {
        await destData.insertBatch(plan, batch.json, 'skip');
        copied += batch.rowCount;
      }

      const sourceCount = await sourceData.count(table.schema, table.name);
      const destCount = await destData.count(table.schema, table.name);

      check(
        `${table.schema}.${table.name} — ${destCount}/${sourceCount} rows`,
        sourceCount === destCount && copied === sourceCount,
        `copied ${copied}, source ${sourceCount}, destination ${destCount}`,
      );
    } catch (err) {
      check(`${table.schema}.${table.name}`, false, err instanceof Error ? err.message : String(err));
    }
  }

  // --- Post-data DDL -------------------------------------------------------
  section('4. Post-data DDL (constraints, indexes, views, triggers, policies)');

  for (const phase of POST_DATA_PHASES) {
    const statements = phases.get(phase) ?? [];
    if (statements.length === 0) continue;

    let ok = 0;
    for (const statement of statements) {
      try {
        await destination.execute(statement.sql);
        ok += 1;
      } catch (err) {
        errors.push(`[${phase}] ${statement.object}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    check(`${phase} — ${ok}/${statements.length} statements`, ok === statements.length);
  }

  if (errors.length > 0) {
    console.log('\n  DDL errors:');
    for (const error of errors) console.log(`    ${error}`);
  }

  // --- Fidelity ------------------------------------------------------------
  section('5. Data fidelity');

  // The headline check. A tool that parses rows into JS objects turns this
  // numeric(30,10) into a float64 and silently corrupts it.
  const money = await destDb.query<{ balance: string }>(
    `select balance::text as balance from public.customers where email = 'ada@example.com'`,
  );
  check(
    'numeric(30,10) survives with full precision',
    money.rows[0]?.balance === '123456789012345678.1234567891',
    `got ${money.rows[0]?.balance ?? 'nothing'} — expected 123456789012345678.1234567891`,
  );

  const tiny = await destDb.query<{ balance: string }>(
    `select balance::text as balance from public.customers where email = 'alan@example.com'`,
  );
  check('sub-nano numeric survives', tiny.rows[0]?.balance === '0.0000000001', `got ${tiny.rows[0]?.balance}`);

  const bytes = await destDb.query<{ hex: string }>(
    `select encode(avatar, 'hex') as hex from public.customers where email = 'ada@example.com'`,
  );
  check('bytea round-trips', bytes.rows[0]?.hex === 'deadbeef', `got ${bytes.rows[0]?.hex}`);

  const jsonb = await destDb.query<{ tier: string; n: number }>(
    `select profile->>'tier' as tier, (profile->>'n')::int as n from public.customers where email = 'ada@example.com'`,
  );
  check('jsonb round-trips', jsonb.rows[0]?.tier === 'gold' && jsonb.rows[0]?.n === 42);

  const arrays = await destDb.query<{ tags: string[] }>(
    `select tags from public.customers where email = 'ada@example.com'`,
  );
  check('text[] round-trips', JSON.stringify(arrays.rows[0]?.tags) === JSON.stringify(['vip', 'early']));

  const composite = await destDb.query<{ city: string }>(
    `select (shipping).city as city from public.customers where email = 'ada@example.com'`,
  );
  check('composite type round-trips', composite.rows[0]?.city === 'London', `got ${composite.rows[0]?.city}`);

  const generated = await destDb.query<{ email_domain: string }>(
    `select email_domain from public.customers where email = 'ada@example.com'`,
  );
  check(
    'generated column recomputed at the destination',
    generated.rows[0]?.email_domain === 'example.com',
    `got ${generated.rows[0]?.email_domain}`,
  );

  const identity = await destDb.query<{ n: string }>(
    `select count(distinct id)::text as n from public.orders`,
  );
  check('IDENTITY ALWAYS ids preserved', identity.rows[0]?.n === '6', `got ${identity.rows[0]?.n} distinct ids`);

  const enums = await destDb.query<{ n: string }>(
    `select count(*)::text as n from public.orders where status = 'paid'`,
  );
  check('enum values preserved', enums.rows[0]?.n === '3', `got ${enums.rows[0]?.n}`);

  // --- Post-migration integrity -------------------------------------------
  section('6. Destination integrity');

  const fks = await destDb.query<{ n: string }>(
    `select count(*)::text as n from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`,
  );
  check('both circular FKs recreated', fks.rows[0]?.n === '2', `got ${fks.rows[0]?.n}`);

  const policies = await destDb.query<{ n: string }>(`select count(*)::text as n from pg_policy`);
  check('RLS policies recreated', policies.rows[0]?.n === '2', `got ${policies.rows[0]?.n}`);

  const rls = await destDb.query<{ on: boolean }>(
    `select relrowsecurity as "on" from pg_class where oid = 'public.customers'::regclass`,
  );
  check('RLS is enabled on customers', rls.rows[0]?.on === true);

  const triggers = await destDb.query<{ n: string }>(
    `select count(*)::text as n from pg_trigger where not tgisinternal`,
  );
  check('trigger recreated', triggers.rows[0]?.n === '1', `got ${triggers.rows[0]?.n}`);

  const views = await destDb.query<{ n: string }>(
    `select count(*)::text as n from pg_class where relkind = 'v' and relnamespace = 'public'::regnamespace`,
  );
  check('both views recreated (dependency-ordered)', views.rows[0]?.n === '2', `got ${views.rows[0]?.n}`);

  // A view over a view is only useful if it actually returns data.
  const viewData = await destDb.query<{ n: string }>(`select count(*)::text as n from public.paid_order_totals`);
  check('view-over-view returns rows', Number(viewData.rows[0]?.n ?? '0') > 0, `got ${viewData.rows[0]?.n}`);

  const partialIndex = await destDb.query<{ def: string }>(
    `select indexdef as def from pg_indexes where indexname = 'orders_unpaid_idx'`,
  );
  check(
    'partial index recreated with its predicate',
    partialIndex.rows[0]?.def.includes('WHERE') === true,
    partialIndex.rows[0]?.def ?? 'index missing',
  );

  // The sequence check. Without `setval`, the next insert reuses an existing invoice
  // number — the single most commonly forgotten step in a hand-rolled migration.
  const nextInvoice = await destDb.query<{ v: string }>(`select nextval('public.invoice_seq')::text as v`);
  check(
    'sequence advanced past migrated rows',
    Number(nextInvoice.rows[0]?.v ?? '0') > 6,
    `nextval returned ${nextInvoice.rows[0]?.v}, which would collide with an existing invoice_no`,
  );

  // The FK constraints are live: an orphan insert must be rejected.
  let fkEnforced = false;
  try {
    await destDb.query(
      `insert into public.orders (customer_id, status, total) values ('99999999-9999-9999-9999-999999999999', 'paid', 1)`,
    );
  } catch {
    fkEnforced = true;
  }
  check('foreign keys are enforced at the destination', fkEnforced);

  await source.dispose();
  await destination.dispose();

  // --- Result --------------------------------------------------------------
  console.log(`\n${'─'.repeat(64)}`);
  const colour = failures === 0 ? '[32m' : '[31m';
  console.log(`${colour}${passes} passed, ${failures} failed[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('\n[31mHarness crashed:[0m', err);
  process.exit(1);
});
