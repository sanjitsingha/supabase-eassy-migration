/**
 * @file Verifies resumability, the checkpoint cursor, and the infra primitives.
 *
 * The claim under test is the one the whole tool is sold on: *if a migration stops
 * midway, the user can continue* — and continuing means picking up from the exact row
 * it stopped at, not restarting the table.
 *
 * So this simulates a crash. It copies part of a 5,000-row table, records the cursor
 * exactly as the orchestrator would checkpoint it, throws the reader away, and starts
 * a completely fresh copy from that cursor. A correct implementation ends with
 * exactly 5,000 rows and re-reads nothing before the cursor. A tool that only *looks*
 * resumable either duplicates rows or starts again from zero.
 *
 * Run with: npx tsx scripts/verify-resume.ts
 */

import { PGlite } from '@electric-sql/pglite';
import type { SqlResult, SqlRow, SqlTransport } from '../src/core/domain/types';
import { IntrospectionRepository } from '../src/core/repositories/introspection.repository';
import { DataRepository } from '../src/core/repositories/data.repository';
import { BandwidthLimiter, runPool, ThroughputMeter, withRetry } from '../src/core/infra/concurrency';
import { credentialVault } from '../src/core/infra/vault';
import { MigrationError } from '../src/core/domain/errors';
import { dollarQuote, inlineParams, quoteIdent, quoteLiteral } from '../src/core/transport/sql';

class PGliteTransport implements SqlTransport {
  readonly kind = 'postgres' as const;
  readonly supportsTransactions = true;

  constructor(private readonly db: PGlite) {}

  async query<T extends SqlRow = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.db.query<T>(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    if (params.length > 0) await this.db.query(sql, params as unknown[]);
    else await this.db.exec(sql);
  }

  async dispose(): Promise<void> {
    await this.db.close();
  }
}

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

const TOTAL_ROWS = 5000;

async function main(): Promise<void> {
  console.log('[1m[36mNebkern — resumability & infrastructure verification[0m\n');

  const sourceDb = new PGlite();
  const destDb = new PGlite();
  const source = new PGliteTransport(sourceDb);
  const destination = new PGliteTransport(destDb);

  const DDL = `
    create table public.events (
      id bigint primary key,
      shard text not null,
      amount numeric(20,8) not null,
      body jsonb
    );
  `;
  await sourceDb.exec(DDL);
  await destDb.exec(DDL);

  await sourceDb.exec(`
    insert into public.events (id, shard, amount, body)
    select g, 'shard-' || (g % 7), (g::numeric / 3), jsonb_build_object('i', g)
    from generate_series(1, ${TOTAL_ROWS}) g;
  `);

  const introspection = new IntrospectionRepository(source);
  const tables = await introspection.tables(['public']);
  const destTables = await new IntrospectionRepository(destination).tables(['public']);

  const plan = DataRepository.plan(tables[0]!, destTables[0]!);
  if (plan === null) throw new Error('Could not build a copy plan');

  const sourceData = new DataRepository(source);
  const destData = new DataRepository(destination);

  // --- Interrupted copy ----------------------------------------------------
  section(`1. Copy ${TOTAL_ROWS.toLocaleString()} rows, then simulate a crash mid-table`);

  const BATCH = 250;
  const CRASH_AFTER_BATCHES = 7; // 1,750 rows in.

  let checkpointCursor: string | null = null;
  let copiedBeforeCrash = 0;
  let batches = 0;

  for await (const batch of sourceData.readBatches(plan, BATCH, null)) {
    await destData.insertBatch(plan, batch.json, 'skip');
    copiedBeforeCrash += batch.rowCount;
    // Exactly what the orchestrator persists on each checkpoint.
    checkpointCursor = batch.nextCursor;
    batches += 1;
    if (batches >= CRASH_AFTER_BATCHES) break; // <- the "crash"
  }

  const afterCrash = await destData.count('public', 'events');
  check(
    `copied ${copiedBeforeCrash.toLocaleString()} rows before the crash`,
    afterCrash === copiedBeforeCrash && afterCrash === BATCH * CRASH_AFTER_BATCHES,
    `destination holds ${afterCrash}`,
  );
  check('a checkpoint cursor was recorded', checkpointCursor !== null, `cursor: ${checkpointCursor}`);
  check(
    'the cursor is the last copied key, not a row offset',
    checkpointCursor === JSON.stringify([String(BATCH * CRASH_AFTER_BATCHES)]),
    `cursor: ${checkpointCursor}`,
  );

  // --- Resume --------------------------------------------------------------
  section('2. Resume from the checkpoint with a brand-new reader');

  // A genuinely fresh reader, exactly as a restarted process would build. It knows
  // nothing except the cursor it read back off disk.
  const resumedSource = new DataRepository(source);
  let copiedAfterResume = 0;
  let rowsRead = 0;

  for await (const batch of resumedSource.readBatches(plan, BATCH, checkpointCursor)) {
    await destData.insertBatch(plan, batch.json, 'skip');
    copiedAfterResume += batch.rowCount;
    rowsRead += batch.rowCount;
  }

  const finalCount = await destData.count('public', 'events');

  check(
    `resume copied the remaining ${(TOTAL_ROWS - copiedBeforeCrash).toLocaleString()} rows`,
    copiedAfterResume === TOTAL_ROWS - copiedBeforeCrash,
    `copied ${copiedAfterResume}`,
  );
  check(
    `destination has exactly ${TOTAL_ROWS.toLocaleString()} rows — no loss, no duplication`,
    finalCount === TOTAL_ROWS,
    `got ${finalCount}`,
  );
  check(
    'the resume re-read nothing before the cursor',
    rowsRead === TOTAL_ROWS - copiedBeforeCrash,
    `re-read ${rowsRead - (TOTAL_ROWS - copiedBeforeCrash)} extra rows`,
  );

  // Row 1,750 (the boundary) must be present exactly once, and row 1,751 must exist.
  const boundary = await destDb.query<{ n: string }>(
    `select count(*)::text as n from public.events where id in (${BATCH * CRASH_AFTER_BATCHES}, ${BATCH * CRASH_AFTER_BATCHES + 1})`,
  );
  check(
    'the rows either side of the checkpoint boundary are intact',
    boundary.rows[0]?.n === '2',
    `expected 2 rows at the boundary, got ${boundary.rows[0]?.n}`,
  );

  const gaps = await destDb.query<{ n: string }>(
    `select count(*)::text as n from generate_series(1, ${TOTAL_ROWS}) g
     where not exists (select 1 from public.events e where e.id = g)`,
  );
  check('no gaps anywhere in the id range', gaps.rows[0]?.n === '0', `${gaps.rows[0]?.n} ids missing`);

  const precision = await destDb.query<{ amount: string }>(
    `select amount::text as amount from public.events where id = 4999`,
  );
  check(
    'numeric precision held across the resume boundary',
    precision.rows[0]?.amount === '1666.33333333',
    `got ${precision.rows[0]?.amount}`,
  );

  // --- Idempotency ---------------------------------------------------------
  section('3. Re-running a completed copy is idempotent');

  let reRun = 0;
  for await (const batch of sourceData.readBatches(plan, 1000, null)) {
    await destData.insertBatch(plan, batch.json, 'skip');
    reRun += batch.rowCount;
  }
  const afterReRun = await destData.count('public', 'events');
  check(
    `re-copied all ${reRun.toLocaleString()} rows but the count is still ${TOTAL_ROWS.toLocaleString()}`,
    afterReRun === TOTAL_ROWS,
    `got ${afterReRun} — ON CONFLICT DO NOTHING is not holding`,
  );

  // --- SQL encoding --------------------------------------------------------
  section('4. SQL literal encoding (the HTTP transports have no bind parameters)');

  check('identifiers with quotes are escaped', quoteIdent('we"ird') === '"we""ird"');
  check("literals with quotes are escaped", quoteLiteral("O'Brien") === "'O''Brien'");

  // The injection case: a value that tries to close the literal and append a statement.
  const hostile = "'; drop table public.events; --";
  const encoded = quoteLiteral(hostile);
  await destination.execute(`select ${encoded} as x`);
  const survived = await destData.count('public', 'events');
  check(
    'a SQL-injection payload is inertly encoded, not executed',
    survived === TOTAL_ROWS,
    `the events table has ${survived} rows — it should still have ${TOTAL_ROWS}`,
  );

  const dollar = dollarQuote('contains $nbk$ already');
  check('dollar-quoting picks a tag that cannot collide', dollar.startsWith('$nbk1$'), dollar.slice(0, 12));

  const interpolated = inlineParams('select $1::int as a, $2::text as b', [42, "it's"]);
  check(
    'placeholders are substituted outside string literals',
    interpolated === `select 42::int as a, 'it''s'::text as b`,
    interpolated,
  );

  const skipped = inlineParams(`select 'a $1 literal' as x, $1::int as y`, [7]);
  check(
    'a $1 inside a string literal is left alone',
    skipped === `select 'a $1 literal' as x, 7::int as y`,
    skipped,
  );

  // --- Retry ---------------------------------------------------------------
  section('5. Retry, backoff and error classification');

  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new MigrationError('CONNECTION_FAILED', 'socket reset', { retryable: true });
      return 'recovered';
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
  );
  check('a retryable error is retried until it succeeds', result === 'recovered' && attempts === 3, `${attempts} attempts`);

  let fatalAttempts = 0;
  const fatal = await withRetry(
    async () => {
      fatalAttempts += 1;
      throw new MigrationError('SQL_ERROR', 'syntax error', { retryable: false });
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
  ).catch((err: unknown) => err);

  check(
    'a non-retryable error fails immediately, without burning attempts',
    fatalAttempts === 1 && fatal instanceof MigrationError,
    `${fatalAttempts} attempts — expected 1`,
  );

  // --- Concurrency pool ----------------------------------------------------
  section('6. Concurrency pool');

  let inFlight = 0;
  let peak = 0;
  let processed = 0;

  await runPool(
    Array.from({ length: 200 }, (_, i) => i),
    5,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      processed += 1;
      inFlight -= 1;
    },
  );

  check('every item is processed', processed === 200, `${processed}/200`);
  check('concurrency never exceeds the limit', peak <= 5, `peak in-flight was ${peak}`);

  // A failing item must not take down the pool when continueOnError is set.
  let handled = 0;
  let completed = 0;
  await runPool(
    Array.from({ length: 20 }, (_, i) => i),
    4,
    async (i) => {
      if (i % 5 === 0) throw new MigrationError('HTTP_ERROR', `item ${i} failed`);
      completed += 1;
    },
    () => {
      handled += 1;
      return true; // continueOnError
    },
  );
  check(
    'a failing item is isolated and the pool continues',
    handled === 4 && completed === 16,
    `${handled} failures handled, ${completed} completed`,
  );

  // --- Bandwidth limiter ---------------------------------------------------
  section('7. Bandwidth limiter (token bucket)');

  const limiter = new BandwidthLimiter(100_000); // 100 KB/s
  const started = Date.now();
  // Drain the initial burst, then take another 50 KB, which must cost ~500ms.
  await limiter.consume(100_000);
  await limiter.consume(50_000);
  const elapsed = Date.now() - started;

  check(
    `throttles to the configured rate (50 KB over 100 KB/s took ${elapsed}ms)`,
    elapsed >= 350,
    `only ${elapsed}ms elapsed — the limiter is not throttling`,
  );

  const unlimited = new BandwidthLimiter(0);
  const freeStart = Date.now();
  await unlimited.consume(500_000_000);
  check('a limit of 0 is unlimited and costs nothing', Date.now() - freeStart < 20);

  // A chunk larger than the whole bucket must not deadlock.
  const small = new BandwidthLimiter(1000);
  const overdraw = Promise.race([
    small.consume(8_000_000).then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 3000)),
  ]);
  check('an oversized chunk overdraws rather than deadlocking', (await overdraw) === 'completed');

  // --- Throughput meter ----------------------------------------------------
  section('8. Throughput meter & ETA');

  const meter = new ThroughputMeter(10_000);
  for (let i = 0; i < 5; i += 1) {
    meter.record(1_000_000, 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rates = meter.rates();
  check('reports a positive byte rate', rates.bytesPerSec > 0, `${Math.round(rates.bytesPerSec)} B/s`);
  check('reports a positive row rate', rates.rowsPerSec > 0, `${Math.round(rates.rowsPerSec)} rows/s`);
  check('estimates an ETA from the remaining work', (meter.eta(10_000, 0) ?? 0) > 0);
  check('no ETA when there is nothing left to do', meter.eta(0, 0) === null);

  // --- Vault ---------------------------------------------------------------
  section('9. Credential vault');

  const secret = {
    type: 'cloud' as const,
    url: 'https://abcdefghijklmnopqrst.supabase.co',
    serviceRoleKey: 'super-secret-service-role-key',
  };

  credentialVault.put('job_test', 'source', secret);
  check('a stored credential can be read back intact', credentialVault.get('job_test', 'source').serviceRoleKey === secret.serviceRoleKey);
  check('the vault reports what it holds', credentialVault.has('job_test', 'source'));

  // The vault's diagnostics must never leak the secret itself.
  const inspected = JSON.stringify(credentialVault.inspect());
  check(
    'inspect() exposes metadata but never the key',
    !inspected.includes(secret.serviceRoleKey) && inspected.includes('job_test'),
    inspected,
  );

  credentialVault.clear('job_test');
  check('clearing removes the credential', !credentialVault.has('job_test', 'source'));

  let threw = false;
  try {
    credentialVault.get('job_test', 'source');
  } catch (err) {
    threw = err instanceof MigrationError && err.code === 'CREDENTIALS_EXPIRED';
  }
  check('reading a cleared credential raises CREDENTIALS_EXPIRED (the resume prompt)', threw);

  await source.dispose();
  await destination.dispose();

  console.log(`\n${'─'.repeat(64)}`);
  const colour = failures === 0 ? '[32m' : '[31m';
  console.log(`${colour}${passes} passed, ${failures} failed[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('\n[31mHarness crashed:[0m', err);
  process.exit(1);
});
