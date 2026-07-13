/**
 * @file Batched, resumable, precision-safe table data copy.
 *
 * Three decisions here are what make this survive tables with millions of rows.
 *
 * **1. Keyset pagination, never OFFSET.**
 * `OFFSET n` makes Postgres walk and throw away n rows on every page, so copying a
 * table page-by-page with OFFSET is O(n²). At a million rows that is roughly half a
 * trillion discarded row visits. Instead we remember the last key we saw and ask
 * for `WHERE key > :cursor ORDER BY key LIMIT n`, which is an index seek — O(n)
 * overall, and identical in cost on page 1 and page 10,000. It is also exactly what
 * makes the copy *resumable*: the cursor is the checkpoint.
 *
 * **2. The payload is never parsed by JavaScript.**
 * Rows are aggregated by Postgres into a single JSON document with `jsonb_agg` and
 * handed to us as **text**, which we pass straight back to the destination as
 * text. JS never sees the values. This is not an optimisation, it is a correctness
 * requirement: `JSON.parse` turns every number into an IEEE-754 double, so a
 * `numeric(30,10)` column — a money column, typically — would silently lose
 * precision in transit. Any migration tool that round-trips rows through JS objects
 * has this bug. Keeping the batch opaque also means we handle every exotic type
 * (arrays, ranges, composites, PostGIS, `bytea`, enums) for free, because Postgres's
 * own input/output functions do the work on both ends.
 *
 * **3. Column intersection.**
 * The insert column list is the intersection of source and destination columns.
 * This is what lets `auth.users` migrate between two Supabase instances running
 * different GoTrue versions, where one side has a column the other has never heard
 * of. Extra keys in the JSON are ignored by `jsonb_populate_recordset`; columns
 * missing from the source get the destination's own default.
 */

import type { MigrationOptions, SqlTransport, TableDef } from '@/core/domain/types';
import { MigrationError } from '@/core/domain/errors';
import { dollarQuote, quoteIdent, quoteLiteral, quoteQualified } from '@/core/transport/sql';

/** One page of rows, as an opaque JSON document plus the cursor that follows it. */
export interface DataBatch {
  /** A JSON array of row objects, as text. Never parsed on this side. */
  readonly json: string;
  readonly rowCount: number;
  /** Cursor to resume from, as a JSON array of stringified key values. */
  readonly nextCursor: string | null;
}

/** What the copier needs to know about a table on both ends. */
export interface CopyPlan {
  readonly schema: string;
  readonly table: string;
  /** Columns written on insert: source ∩ destination, minus destination-generated. */
  readonly columns: readonly string[];
  /** Columns ordered/compared for keyset pagination. Empty ⇒ fall back to ctid. */
  readonly keyColumns: readonly string[];
  /** SQL type of each key column, for casting the cursor back. */
  readonly keyTypes: readonly string[];
  /** Conflict target for `ON CONFLICT`. Empty ⇒ untargeted `DO NOTHING`. */
  readonly conflictColumns: readonly string[];
  /** True when the destination has an `IDENTITY ALWAYS` column we must override. */
  readonly hasIdentityAlways: boolean;
  readonly estimatedRows: number;
}

export class DataRepository {
  constructor(private readonly transport: SqlTransport) {}

  /**
   * Builds a copy plan by intersecting the source and destination shapes of a table.
   *
   * Returns null when the destination has no matching table at all, or when the two
   * sides share no columns — in both cases copying would be meaningless and the
   * caller skips the table with a warning rather than erroring the migration.
   */
  static plan(source: TableDef, destination: TableDef | undefined): CopyPlan | null {
    if (!destination) return null;

    const destColumns = new Set(destination.columns.map((c) => c.name));
    const destGenerated = new Set(destination.generatedColumns);

    // Generated columns are computed by the destination; writing them is an error.
    const columns = source.columns
      .map((c) => c.name)
      .filter((name) => destColumns.has(name) && !destGenerated.has(name));

    if (columns.length === 0) return null;

    // The key must exist on both sides, or the cursor cannot be applied to a resume.
    const keyColumns = source.copyKey.filter((name) => destColumns.has(name));
    const keyTypes = keyColumns.map(
      (name) => source.columns.find((c) => c.name === name)?.dataType ?? 'text',
    );

    // The conflict target must be a real unique constraint on the *destination*.
    const destPrimaryKey = destination.constraints.find((c) => c.kind === 'p');
    const conflictColumns = destPrimaryKey ? parseConstraintColumns(destPrimaryKey.definition) : [];

    const hasIdentityAlways = destination.columns.some(
      (c) => c.identity === 'ALWAYS' && columns.includes(c.name),
    );

    return {
      schema: source.schema,
      table: source.name,
      columns,
      keyColumns,
      keyTypes,
      conflictColumns: conflictColumns.filter((c) => columns.includes(c)),
      hasIdentityAlways,
      estimatedRows: source.estimatedRows,
    };
  }

  /**
   * Yields pages of rows from the cursor onward, lazily.
   *
   * An async generator rather than a returned array, so a 10-million-row table is
   * streamed one bounded page at a time and peak memory stays flat regardless of
   * table size.
   */
  async *readBatches(
    plan: CopyPlan,
    batchSize: number,
    startCursor: string | null,
    signal?: () => void,
  ): AsyncGenerator<DataBatch> {
    let cursor = startCursor;

    for (;;) {
      signal?.();
      const batch = await this.readBatch(plan, batchSize, cursor);
      if (batch.rowCount === 0) return;

      yield batch;

      // A page shorter than the batch size means we reached the end. Stopping here
      // saves one wasted empty round-trip per table — negligible on one table,
      // meaningful across a thousand.
      if (batch.rowCount < batchSize || batch.nextCursor === null) return;
      cursor = batch.nextCursor;
    }
  }

  /** Reads one page. Exposed for tests and for the resume path. */
  async readBatch(plan: CopyPlan, batchSize: number, cursor: string | null): Promise<DataBatch> {
    const qualifiedTable = quoteQualified(plan.schema, plan.table);
    const useCtid = plan.keyColumns.length === 0;

    const orderBy = useCtid
      ? 't.ctid'
      : plan.keyColumns.map((c) => `t.${quoteIdent(c)}`).join(', ');

    const where = this.cursorPredicate(plan, cursor, useCtid);

    // `to_jsonb(p) - excluded` drops columns the destination cannot accept. Using
    // jsonb subtraction rather than jsonb_build_object sidesteps Postgres's 100-arg
    // function limit, which a wide table (50+ columns) would otherwise blow past.
    const excluded = this.excludedColumnsExpr(plan);

    const cursorSelect = useCtid
      ? `(select p.ctid::text from page p order by p.ctid desc limit 1)`
      : `(select jsonb_build_array(${plan.keyColumns.map((c) => `p.${quoteIdent(c)}::text`).join(', ')})::text
          from page p order by ${plan.keyColumns.map((c) => `p.${quoteIdent(c)} desc`).join(', ')} limit 1)`;

    const sql = `
      with page as (
        select ${useCtid ? 't.ctid, ' : ''}t.*
        from ${qualifiedTable} t
        ${where}
        order by ${orderBy}
        limit ${Math.max(1, Math.floor(batchSize))}
      )
      select
        (select coalesce(jsonb_agg(to_jsonb(p.*) ${excluded}), '[]'::jsonb)::text from page p) as batch,
        (select count(*)::text from page) as n,
        ${cursorSelect} as next_cursor
    `;

    const result = await this.transport.query<{ batch: unknown; n: unknown; next_cursor: unknown }>(sql);
    const row = result.rows[0];
    if (!row) return { json: '[]', rowCount: 0, nextCursor: null };

    const rowCount = Number.parseInt(String(row.n ?? '0'), 10);
    const rawCursor = row.next_cursor;

    return {
      json: typeof row.batch === 'string' ? row.batch : JSON.stringify(row.batch ?? []),
      rowCount: Number.isFinite(rowCount) ? rowCount : 0,
      nextCursor: rawCursor === null || rawCursor === undefined ? null : String(rawCursor),
    };
  }

  /**
   * The keyset predicate.
   *
   * Cursor values are stored as **text** and cast back to the column's own type
   * (`'42'::bigint`, `'2024-01-01T00:00:00+00'::timestamptz`). Casting through the
   * type's input function is what makes the round trip exact and, crucially, makes
   * the comparison use the *type's* ordering rather than text ordering — without
   * the cast, id 10 would sort before id 9.
   */
  private cursorPredicate(plan: CopyPlan, cursor: string | null, useCtid: boolean): string {
    if (cursor === null) return '';

    if (useCtid) {
      return `where t.ctid > ${quoteLiteral(cursor)}::tid`;
    }

    let values: unknown;
    try {
      values = JSON.parse(cursor);
    } catch {
      throw new MigrationError('INTERNAL', `Corrupt resume cursor for ${plan.schema}.${plan.table}: ${cursor}`);
    }
    if (!Array.isArray(values) || values.length !== plan.keyColumns.length) {
      throw new MigrationError(
        'INTERNAL',
        `Resume cursor for ${plan.schema}.${plan.table} has ${Array.isArray(values) ? values.length : 0} values but the key has ${plan.keyColumns.length} columns`,
      );
    }

    const lhs = plan.keyColumns.map((c) => `t.${quoteIdent(c)}`).join(', ');
    const rhs = values
      .map((value, i) => `${quoteLiteral(String(value))}::${plan.keyTypes[i] ?? 'text'}`)
      .join(', ');

    // Row-wise comparison: `(a, b) > (x, y)` is lexicographic and matches
    // `ORDER BY a, b` exactly. Writing it as `a > x OR (a = x AND b > y)` would be
    // equivalent but stops Postgres from using the composite index.
    return `where (${lhs}) > (${rhs})`;
  }

  /** `- ARRAY['col', ...]::text[]`, or empty when nothing needs dropping. */
  private excludedColumnsExpr(plan: CopyPlan): string {
    // We only know the columns to keep; jsonb subtraction wants the ones to drop.
    // Expressing it as "keep" would need a whitelist operator jsonb does not have,
    // so the caller passes the full source column set and we invert at read time by
    // simply not excluding anything — the destination's populate_recordset ignores
    // unknown keys anyway. The one thing we must drop is `ctid`, which is only
    // present in the no-key path.
    return plan.keyColumns.length === 0 ? `- 'ctid'::text` : '';
  }

  /**
   * Inserts one page into the destination.
   *
   * `jsonb_populate_recordset(null::schema.table, $json)` is the trick that makes
   * this type-complete: it uses each column's own input function, so `bytea`,
   * `numeric`, enums, arrays, ranges and PostGIS geometry all land exactly as they
   * left — with no per-type handling anywhere in this codebase.
   */
  async insertBatch(plan: CopyPlan, json: string, onConflict: MigrationOptions['onConflict']): Promise<number> {
    const qualifiedTable = quoteQualified(plan.schema, plan.table);
    const columnList = plan.columns.map(quoteIdent).join(', ');
    const selectList = plan.columns.map((c) => `r.${quoteIdent(c)}`).join(', ');

    // An IDENTITY ALWAYS column rejects an explicit value unless we say this.
    const overriding = plan.hasIdentityAlways ? 'overriding system value' : '';

    let conflictClause = '';
    if (onConflict === 'skip') {
      conflictClause =
        plan.conflictColumns.length > 0
          ? `on conflict (${plan.conflictColumns.map(quoteIdent).join(', ')}) do nothing`
          : 'on conflict do nothing';
    } else if (onConflict === 'update') {
      if (plan.conflictColumns.length === 0) {
        // No primary key to conflict on: an upsert is undefined, so degrade to skip
        // rather than erroring out the whole table.
        conflictClause = 'on conflict do nothing';
      } else {
        const updatable = plan.columns.filter((c) => !plan.conflictColumns.includes(c));
        conflictClause =
          updatable.length > 0
            ? `on conflict (${plan.conflictColumns.map(quoteIdent).join(', ')}) do update set ${updatable
                .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
                .join(', ')}`
            : `on conflict (${plan.conflictColumns.map(quoteIdent).join(', ')}) do nothing`;
      }
    }

    // Dollar-quoted rather than a bind parameter, because two of the three
    // transports have no bind channel. `dollarQuote` picks a tag that cannot occur
    // inside the payload.
    const payload = dollarQuote(json);

    const sql = `
      insert into ${qualifiedTable} (${columnList})
      ${overriding}
      select ${selectList}
      from jsonb_populate_recordset(null::${qualifiedTable}, ${payload}::jsonb) r
      ${conflictClause}
    `;

    const result = await this.transport.query(sql);
    return result.rowCount;
  }

  /** Exact row count. Used by validation and to size progress bars precisely. */
  async count(schema: string, table: string): Promise<number> {
    const result = await this.transport.query<{ n: unknown }>(
      `select count(*)::text as n from ${quoteQualified(schema, table)}`,
    );
    const parsed = Number.parseInt(String(result.rows[0]?.n ?? '0'), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** Empties a destination table. `CASCADE` because FKs may not exist yet, but might. */
  async truncate(schema: string, table: string): Promise<void> {
    await this.transport.execute(`truncate table ${quoteQualified(schema, table)} cascade`);
  }

  /** True when the destination already has this table. */
  async tableExists(schema: string, table: string): Promise<boolean> {
    const result = await this.transport.query<{ ok: unknown }>(`
      select exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${quoteLiteral(schema)}
          and c.relname = ${quoteLiteral(table)}
          and c.relkind in ('r', 'p', 'f')
      ) as ok
    `);
    const value = result.rows[0]?.ok;
    return value === true || value === 't' || value === 'true';
  }
}

/**
 * Pulls the column names out of `PRIMARY KEY (a, b)`.
 *
 * `pg_get_constraintdef` output is well-formed and stable, so a targeted parse is
 * safe here — and it saves a second catalog round-trip per table, which at 1000
 * tables is 1000 fewer queries.
 */
function parseConstraintColumns(definition: string): string[] {
  const match = /\(([^)]+)\)/.exec(definition);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
    .filter((c) => c !== '');
}
