/**
 * @file Reads the complete structure of a Postgres database out of `pg_catalog`.
 *
 * This is the replacement for `pg_dump --schema-only`, and the reason the tool can
 * claim to work "through the APIs": every statement here is an ordinary `SELECT`,
 * so it runs identically over the Management API, over a PostgREST RPC, or over a
 * socket. No binary, no subprocess, no `pg_dump` version-matching pain.
 *
 * Where Postgres already knows how to render an object as SQL we ask it rather
 * than reconstructing the text ourselves — `pg_get_functiondef`, `pg_get_viewdef`,
 * `pg_get_triggerdef`, `pg_get_constraintdef`, `pg_get_indexdef`. Those built-ins
 * handle the long tail (operator classes, collations, `WITH` options, partial index
 * predicates, SQL-body functions) that hand-rolled DDL generation always gets
 * subtly wrong. We hand-build DDL only for the objects Postgres has no
 * `pg_get_*def` for: tables, sequences, types, and policies.
 *
 * Every numeric column is cast to `text` in SQL and parsed in TS. That is not
 * fussiness: `pg` returns `bigint` as a string while the Management API returns it
 * as a JSON number, and a repository that behaved differently depending on which
 * transport it was handed would be a nightmare to debug.
 */

import type {
  ColumnDef,
  ConstraintDef,
  DatabaseSchema,
  ExtensionDef,
  GrantDef,
  IndexDef,
  PolicyDef,
  PublicationDef,
  RoutineDef,
  SchemaDef,
  SequenceDef,
  SqlTransport,
  TableDef,
  TriggerDef,
  TypeDef,
  ViewDef,
} from '@/core/domain/types';
import { MANAGED_SCHEMAS, SYSTEM_SCHEMAS } from '@/core/domain/constants';
import { quoteLiteral, quoteQualified } from '@/core/transport/sql';

// ---------------------------------------------------------------------------
// Value coercion — normalises the differences between transports
// ---------------------------------------------------------------------------

function asStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function asNullableStr(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function asNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 't' || value === 'true' || value === 'TRUE';
  return Boolean(value);
}

/**
 * Postgres text arrays arrive as a real JS array over `pg`, but the Management
 * API may hand back the raw `{a,b}` literal. Handle both.
 */
function asStrArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '{}') return [];
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s !== '');
    }
    return [trimmed];
  }
  return [];
}

/** Renders a string list as a SQL `IN (...)` body. Empty lists become `(NULL)`. */
function inList(values: readonly string[]): string {
  if (values.length === 0) return '(NULL)';
  return `(${values.map(quoteLiteral).join(', ')})`;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class IntrospectionRepository {
  constructor(private readonly transport: SqlTransport) {}

  /** `SELECT version()` — e.g. `PostgreSQL 15.8 on aarch64-...`. */
  async postgresVersion(): Promise<string> {
    const result = await this.transport.query<{ version: string }>('select version() as version');
    return asStr(result.rows[0]?.version);
  }

  /**
   * Best-effort Supabase platform version.
   *
   * There is no official "what version of Supabase is this" endpoint, so we infer
   * it from the most recent applied platform migration, which is the closest thing
   * to a version marker that exists on both Cloud and self-hosted.
   */
  async supabaseVersion(): Promise<string | null> {
    const result = await this.transport.query<{ version: unknown }>(`
      select max(version) as version
      from (
        select version::text from auth.schema_migrations
        union all
        select name::text from storage.migrations
      ) v
    `).catch(() => null);
    return result ? asNullableStr(result.rows[0]?.version) : null;
  }

  async databaseSizeBytes(): Promise<number> {
    const result = await this.transport
      .query<{ bytes: unknown }>(`select pg_database_size(current_database())::text as bytes`)
      .catch(() => null);
    return result ? asNum(result.rows[0]?.bytes) : 0;
  }

  /**
   * Lists every schema, flagging the ones Supabase manages.
   *
   * The `managed` flag drives the single most important policy decision in the
   * tool: managed schemas get their **data** migrated but never their **DDL**. A
   * destination project already has its own `auth.users` at its own platform
   * version, and replaying the source's `CREATE TABLE auth.users` over it would at
   * best fail and at worst silently downgrade the destination's auth schema.
   */
  async schemas(): Promise<readonly SchemaDef[]> {
    const rows = await this.transport.query<{
      name: string;
      owner: string;
      comment: unknown;
    }>(`
      select
        n.nspname as name,
        pg_catalog.pg_get_userbyid(n.nspowner) as owner,
        obj_description(n.oid, 'pg_namespace') as comment
      from pg_catalog.pg_namespace n
      where n.nspname not in ${inList([...SYSTEM_SCHEMAS])}
        and n.nspname not like 'pg\\_temp\\_%'
        and n.nspname not like 'pg\\_toast\\_temp\\_%'
      order by n.nspname
    `);

    const managed = new Set<string>(MANAGED_SCHEMAS);
    return rows.rows.map((r) => ({
      name: asStr(r.name),
      owner: asStr(r.owner),
      comment: asNullableStr(r.comment),
      managed: managed.has(asStr(r.name)),
    }));
  }

  async extensions(): Promise<readonly ExtensionDef[]> {
    const result = await this.transport.query<{
      name: string;
      schema: string;
      version: string;
      comment: unknown;
    }>(`
      select
        e.extname as name,
        n.nspname as schema,
        e.extversion as version,
        obj_description(e.oid, 'pg_extension') as comment
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
      order by e.extname
    `);

    return result.rows.map((r) => ({
      name: asStr(r.name),
      schema: asStr(r.schema),
      version: asStr(r.version),
      comment: asNullableStr(r.comment),
    }));
  }

  /**
   * User-defined types: enums, composites, domains, ranges.
   *
   * These must be created before any table that uses them, which is why they get
   * their own early stage. A missing enum is the classic "why did my CREATE TABLE
   * fail" of hand-rolled Supabase migrations.
   */
  async types(schemas: readonly string[]): Promise<readonly TypeDef[]> {
    const result = await this.transport.query<{
      schema: string;
      name: string;
      kind: string;
      enum_labels: unknown;
      attributes: unknown;
      domain_base: unknown;
      domain_not_null: unknown;
      domain_default: unknown;
      domain_checks: unknown;
      comment: unknown;
    }>(`
      select
        n.nspname as schema,
        t.typname as name,
        case
          when t.typtype = 'e' then 'enum'
          when t.typtype = 'c' then 'composite'
          when t.typtype = 'd' then 'domain'
          when t.typtype = 'r' then 'range'
        end as kind,
        case when t.typtype = 'e' then (
          select array_agg(e.enumlabel order by e.enumsortorder)
          from pg_catalog.pg_enum e where e.enumtypid = t.oid
        ) end as enum_labels,
        case when t.typtype = 'c' then (
          select array_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) order by a.attnum)
          from pg_catalog.pg_attribute a
          where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped
        ) end as attributes,
        case when t.typtype = 'd'
          then pg_catalog.format_type(t.typbasetype, t.typtypmod) end as domain_base,
        t.typnotnull as domain_not_null,
        t.typdefault as domain_default,
        case when t.typtype = 'd' then (
          select array_agg(pg_catalog.pg_get_constraintdef(c.oid))
          from pg_catalog.pg_constraint c where c.contypid = t.oid
        ) end as domain_checks,
        obj_description(t.oid, 'pg_type') as comment
      from pg_catalog.pg_type t
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      where n.nspname in ${inList(schemas)}
        and t.typtype in ('e', 'c', 'd', 'r')
        -- Exclude the implicit row type every table gets; it is not a user type.
        and (t.typrelid = 0 or (
          select c.relkind from pg_catalog.pg_class c where c.oid = t.typrelid
        ) = 'c')
        -- Exclude array types, which Postgres auto-creates alongside every type.
        and not exists (
          select 1 from pg_catalog.pg_type el where el.oid = t.typelem and el.typarray = t.oid
        )
      order by n.nspname, t.typname
    `);

    return result.rows.map((r) => {
      const attributes = asStrArray(r.attributes).map((entry) => {
        const idx = entry.indexOf(' ');
        return { name: entry.slice(0, idx), type: entry.slice(idx + 1) };
      });

      const kindRaw = asStr(r.kind);
      const kind: TypeDef['kind'] =
        kindRaw === 'enum' || kindRaw === 'composite' || kindRaw === 'domain' || kindRaw === 'range'
          ? kindRaw
          : 'composite';

      return {
        schema: asStr(r.schema),
        name: asStr(r.name),
        kind,
        enumLabels: asStrArray(r.enum_labels),
        attributes,
        domainBase: asNullableStr(r.domain_base),
        domainNotNull: asBool(r.domain_not_null),
        domainDefault: asNullableStr(r.domain_default),
        domainChecks: asStrArray(r.domain_checks),
        comment: asNullableStr(r.comment),
      };
    });
  }

  /**
   * Tables, with everything needed to recreate them *and* to copy their data.
   *
   * `copy_key` is the interesting part. Data is copied with keyset pagination
   * (`WHERE key > :cursor ORDER BY key LIMIT n`) rather than `OFFSET`, because
   * `OFFSET n` makes Postgres walk and discard n rows every page — quadratic, and
   * catastrophic past a few hundred thousand rows. The key is the primary key if
   * there is one, otherwise any all-NOT-NULL unique index. Tables with neither fall
   * back to `ctid` ordering in the copier.
   */
  async tables(schemas: readonly string[]): Promise<readonly TableDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as name,
        c.relkind as relkind,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        c.reltuples::text as estimated_rows,
        pg_catalog.pg_total_relation_size(c.oid)::text as total_bytes,
        obj_description(c.oid, 'pg_class') as comment,
        case when c.relispartition then (
          select pg_catalog.pg_get_expr(c.relpartbound, c.oid)
        ) end as partition_expr,
        case when c.relispartition then (
          select pn.nspname || '.' || pc.relname
          from pg_catalog.pg_inherits i
          join pg_catalog.pg_class pc on pc.oid = i.inhparent
          join pg_catalog.pg_namespace pn on pn.oid = pc.relnamespace
          where i.inhrelid = c.oid
        ) end as parent_table,
        (
          -- Prefer the primary key; otherwise the narrowest all-NOT-NULL unique index.
          select array_agg(a.attname order by k.ord)
          from (
            select i.indexrelid, i.indkey, i.indisprimary
            from pg_catalog.pg_index i
            where i.indrelid = c.oid
              and i.indisvalid
              and (i.indisprimary or i.indisunique)
              and i.indpred is null
              and i.indexprs is null
            order by i.indisprimary desc, array_length(i.indkey::int[], 1) asc
            limit 1
          ) idx
          cross join lateral unnest(idx.indkey::int[]) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where a.attnotnull
        ) as copy_key,
        (
          select array_agg(a.attname order by a.attnum)
          from pg_catalog.pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated <> ''
        ) as generated_columns
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'f')
        and n.nspname in ${inList(schemas)}
      order by n.nspname, c.relname
    `);

    const [columns, constraints, indexes] = await Promise.all([
      this.columns(schemas),
      this.constraints(schemas),
      this.indexes(schemas),
    ]);

    return result.rows.map((r) => {
      const schema = asStr(r.schema);
      const name = asStr(r.name);
      const key = `${schema}.${name}`;
      const relkind = asStr(r.relkind);
      const estimated = asNum(r.estimated_rows);

      return {
        schema,
        name,
        kind: relkind === 'p' ? 'partitioned' : relkind === 'f' ? 'foreign' : 'table',
        columns: columns.get(key) ?? [],
        constraints: constraints.get(key) ?? [],
        indexes: indexes.get(key) ?? [],
        rlsEnabled: asBool(r.rls_enabled),
        rlsForced: asBool(r.rls_forced),
        comment: asNullableStr(r.comment),
        partitionExpr: asNullableStr(r.partition_expr),
        parentTable: asNullableStr(r.parent_table),
        // reltuples is -1 when the table has never been analysed. Surface 0 rather
        // than a negative row count leaking into progress bars and ETA maths.
        estimatedRows: estimated < 0 ? 0 : Math.round(estimated),
        totalBytes: asNum(r.total_bytes),
        copyKey: asStrArray(r.copy_key),
        generatedColumns: asStrArray(r.generated_columns),
      } satisfies TableDef;
    });
  }

  /** Columns for every table, grouped by `schema.table`. */
  private async columns(schemas: readonly string[]): Promise<Map<string, ColumnDef[]>> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as table_name,
        a.attname as name,
        a.attnum::text as position,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        not a.attnotnull as is_nullable,
        case when a.attgenerated = '' then pg_catalog.pg_get_expr(d.adbin, d.adrelid) end as default_expr,
        case a.attidentity when 'a' then 'ALWAYS' when 'd' then 'BY DEFAULT' else null end as identity,
        case when a.attgenerated <> '' then pg_catalog.pg_get_expr(d.adbin, d.adrelid) end as generated_expr,
        case
          when a.attcollation <> 0 and a.attcollation <> t.typcollation
          then (select cn.nspname || '.' || cl.collname
                from pg_catalog.pg_collation cl
                join pg_catalog.pg_namespace cn on cn.oid = cl.collnamespace
                where cl.oid = a.attcollation)
        end as collation,
        col_description(c.oid, a.attnum) as comment
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_type t on t.oid = a.atttypid
      left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where c.relkind in ('r', 'p', 'f')
        and n.nspname in ${inList(schemas)}
        and a.attnum > 0
        and not a.attisdropped
      order by n.nspname, c.relname, a.attnum
    `);

    const map = new Map<string, ColumnDef[]>();
    for (const r of result.rows) {
      const key = `${asStr(r.schema)}.${asStr(r.table_name)}`;
      const identityRaw = asNullableStr(r.identity);

      const column: ColumnDef = {
        name: asStr(r.name),
        position: asNum(r.position),
        dataType: asStr(r.data_type),
        isNullable: asBool(r.is_nullable),
        defaultExpr: asNullableStr(r.default_expr),
        identity: identityRaw === 'ALWAYS' || identityRaw === 'BY DEFAULT' ? identityRaw : null,
        identityOptions: null,
        generatedExpr: asNullableStr(r.generated_expr),
        collation: asNullableStr(r.collation),
        comment: asNullableStr(r.comment),
      };

      const list = map.get(key);
      if (list) list.push(column);
      else map.set(key, [column]);
    }
    return map;
  }

  /** Constraints, grouped by `schema.table`. Definitions come from `pg_get_constraintdef`. */
  private async constraints(schemas: readonly string[]): Promise<Map<string, ConstraintDef[]>> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as table_name,
        con.conname as name,
        con.contype as kind,
        pg_catalog.pg_get_constraintdef(con.oid) as definition,
        con.condeferrable as is_deferrable,
        case when con.contype = 'f' then (
          select fn.nspname || '.' || fc.relname
          from pg_catalog.pg_class fc
          join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
          where fc.oid = con.confrelid
        ) end as referenced_table
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${inList(schemas)}
        and con.contype in ('p', 'u', 'f', 'c', 'x')
        -- Constraints inherited from a partitioned parent are created with the parent.
        and con.conparentid = 0
      order by n.nspname, c.relname, con.contype, con.conname
    `);

    const map = new Map<string, ConstraintDef[]>();
    for (const r of result.rows) {
      const key = `${asStr(r.schema)}.${asStr(r.table_name)}`;
      const kindRaw = asStr(r.kind);
      const kind: ConstraintDef['kind'] =
        kindRaw === 'p' || kindRaw === 'u' || kindRaw === 'f' || kindRaw === 'c' || kindRaw === 'x' ? kindRaw : 'c';

      const constraint: ConstraintDef = {
        name: asStr(r.name),
        kind,
        definition: asStr(r.definition),
        referencedTable: asNullableStr(r.referenced_table),
        isDeferrable: asBool(r.is_deferrable),
      };

      const list = map.get(key);
      if (list) list.push(constraint);
      else map.set(key, [constraint]);
    }
    return map;
  }

  /** Indexes, grouped by `schema.table`. Definitions come from `pg_get_indexdef`. */
  private async indexes(schemas: readonly string[]): Promise<Map<string, IndexDef[]>> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as table_name,
        ic.relname as name,
        pg_catalog.pg_get_indexdef(i.indexrelid) as definition,
        i.indisprimary as is_primary,
        i.indisunique as is_unique,
        -- An index that backs a constraint is created by the constraint itself;
        -- emitting a separate CREATE INDEX for it would be a duplicate.
        exists (
          select 1 from pg_catalog.pg_constraint con
          where con.conindid = i.indexrelid and con.contype in ('p','u','x')
        ) as is_constraint_backed
      from pg_catalog.pg_index i
      join pg_catalog.pg_class ic on ic.oid = i.indexrelid
      join pg_catalog.pg_class c on c.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${inList(schemas)}
        and c.relkind in ('r', 'p')
        and i.indisvalid
      order by n.nspname, c.relname, ic.relname
    `);

    const map = new Map<string, IndexDef[]>();
    for (const r of result.rows) {
      const key = `${asStr(r.schema)}.${asStr(r.table_name)}`;
      const index: IndexDef = {
        name: asStr(r.name),
        definition: asStr(r.definition),
        isPrimary: asBool(r.is_primary),
        isUnique: asBool(r.is_unique),
        isConstraintBacked: asBool(r.is_constraint_backed),
      };

      const list = map.get(key);
      if (list) list.push(index);
      else map.set(key, [index]);
    }
    return map;
  }

  /**
   * Sequences, including their current value.
   *
   * `last_value` is why sequences need their own stage *after* data: copying rows
   * with explicit ids does not advance the destination's sequence, so the first
   * insert your application makes after the migration would collide with an
   * existing id. We replay `setval` to fix that.
   */
  async sequences(schemas: readonly string[]): Promise<readonly SequenceDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        s.schemaname as schema,
        s.sequencename as name,
        s.data_type::text as data_type,
        s.start_value::text as start_value,
        s.min_value::text as min_value,
        s.max_value::text as max_value,
        s.increment_by::text as increment_by,
        s.cycle as cycles,
        s.cache_size::text as cache_size,
        s.last_value::text as last_value,
        (
          select jsonb_build_object(
            'schema', dn.nspname,
            'table', dc.relname,
            'column', da.attname,
            -- deptype 'i' (internal) means an identity column owns this sequence;
            -- 'a' (auto) means a serial column does. They need opposite treatment.
            'identity', d.deptype = 'i'
          )
          from pg_catalog.pg_depend d
          join pg_catalog.pg_class dc on dc.oid = d.refobjid
          join pg_catalog.pg_namespace dn on dn.oid = dc.relnamespace
          join pg_catalog.pg_attribute da on da.attrelid = d.refobjid and da.attnum = d.refobjsubid
          where d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass
            and d.deptype in ('a', 'i')
            and d.refobjsubid > 0
          limit 1
        ) as owned_by
      from pg_catalog.pg_sequences s
      where s.schemaname in ${inList(schemas)}
      order by s.schemaname, s.sequencename
    `);

    return result.rows.map((r) => {
      const owned = r.owned_by;
      let ownedBy: SequenceDef['ownedBy'] = null;
      let ownedByIdentity = false;

      if (owned !== null && owned !== undefined) {
        const parsed = (typeof owned === 'string' ? JSON.parse(owned) : owned) as Record<string, unknown>;
        ownedBy = {
          schema: asStr(parsed.schema),
          table: asStr(parsed.table),
          column: asStr(parsed.column),
        };
        ownedByIdentity = asBool(parsed.identity);
      }

      return {
        schema: asStr(r.schema),
        name: asStr(r.name),
        dataType: asStr(r.data_type) || 'bigint',
        startValue: asStr(r.start_value),
        minValue: asStr(r.min_value),
        maxValue: asStr(r.max_value),
        incrementBy: asStr(r.increment_by),
        cycles: asBool(r.cycles),
        cacheSize: asStr(r.cache_size),
        lastValue: asNullableStr(r.last_value),
        ownedBy,
        ownedByIdentity,
      } satisfies SequenceDef;
    });
  }

  /**
   * Views and materialised views.
   *
   * `depends_on` lets the DDL stage topologically sort them: a view selecting from
   * another view must be created second, and with 1000+ objects you cannot rely on
   * alphabetical luck.
   */
  async views(schemas: readonly string[]): Promise<readonly ViewDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as name,
        (c.relkind = 'm') as materialized,
        pg_catalog.pg_get_viewdef(c.oid, true) as definition,
        obj_description(c.oid, 'pg_class') as comment,
        coalesce(
          (select array_agg(distinct dn.nspname || '.' || dc.relname)
           from pg_catalog.pg_depend d
           join pg_catalog.pg_rewrite r on r.oid = d.objid
           join pg_catalog.pg_class dc on dc.oid = d.refobjid
           join pg_catalog.pg_namespace dn on dn.oid = dc.relnamespace
           where r.ev_class = c.oid
             and d.refobjid <> c.oid
             and d.classid = 'pg_rewrite'::regclass
             and dc.relkind in ('r','v','m','p','f')),
          '{}'::text[]
        ) as depends_on,
        coalesce(
          (select array_to_string(c.reloptions, ',') like '%security_invoker=%'), false
        ) as is_security_invoker
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm')
        and n.nspname in ${inList(schemas)}
      order by n.nspname, c.relname
    `);

    return result.rows.map((r) => ({
      schema: asStr(r.schema),
      name: asStr(r.name),
      materialized: asBool(r.materialized),
      definition: asStr(r.definition),
      comment: asNullableStr(r.comment),
      dependsOn: asStrArray(r.depends_on),
      isSecurityInvoker: asBool(r.is_security_invoker),
    }));
  }

  /** Functions and procedures. `pg_get_functiondef` gives us complete, valid SQL. */
  async routines(schemas: readonly string[]): Promise<readonly RoutineDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        p.proname as name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_args,
        case p.prokind
          when 'f' then 'function'
          when 'p' then 'procedure'
          when 'a' then 'aggregate'
          when 'w' then 'window'
        end as kind,
        case when p.prokind in ('f','p') then pg_catalog.pg_get_functiondef(p.oid) end as definition,
        l.lanname as language,
        obj_description(p.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname in ${inList(schemas)}
        -- Functions installed by an extension are recreated by CREATE EXTENSION.
        and not exists (
          select 1 from pg_catalog.pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
        )
      order by n.nspname, p.proname
    `);

    return result.rows
      .filter((r) => asNullableStr(r.definition) !== null)
      .map((r) => {
        const kindRaw = asStr(r.kind);
        const kind: RoutineDef['kind'] =
          kindRaw === 'function' || kindRaw === 'procedure' || kindRaw === 'aggregate' || kindRaw === 'window'
            ? kindRaw
            : 'function';

        return {
          schema: asStr(r.schema),
          name: asStr(r.name),
          identityArgs: asStr(r.identity_args),
          kind,
          definition: asStr(r.definition),
          language: asStr(r.language),
          comment: asNullableStr(r.comment),
        } satisfies RoutineDef;
      });
  }

  /** Triggers. `pg_get_triggerdef` gives us complete, valid SQL. */
  async triggers(schemas: readonly string[]): Promise<readonly TriggerDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as table_name,
        t.tgname as name,
        pg_catalog.pg_get_triggerdef(t.oid, true) as definition,
        t.tgenabled as enabled_state
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${inList(schemas)}
        -- tgisinternal excludes the triggers Postgres creates to enforce FK and
        -- deferred-constraint checks. Recreating those by hand would be wrong:
        -- they belong to the constraint and are made when the constraint is made.
        and not t.tgisinternal
      order by n.nspname, c.relname, t.tgname
    `);

    return result.rows.map((r) => {
      const state = asStr(r.enabled_state);
      return {
        name: asStr(r.name),
        schema: asStr(r.schema),
        table: asStr(r.table_name),
        definition: asStr(r.definition),
        enabledState: state === 'D' || state === 'R' || state === 'A' ? state : 'O',
      } satisfies TriggerDef;
    });
  }

  /** Row-level security policies. Postgres has no `pg_get_policydef`, so we rebuild these. */
  async policies(schemas: readonly string[]): Promise<readonly PolicyDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as table_name,
        p.polname as name,
        case p.polcmd
          when 'r' then 'SELECT'
          when 'a' then 'INSERT'
          when 'w' then 'UPDATE'
          when 'd' then 'DELETE'
          else 'ALL'
        end as command,
        p.polpermissive as permissive,
        coalesce(
          (select array_agg(pg_catalog.pg_get_userbyid(r) order by r) from unnest(p.polroles) r
           where r <> 0),
          array['public']::text[]
        ) as roles,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using_expr,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_catalog.pg_policy p
      join pg_catalog.pg_class c on c.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${inList(schemas)}
      order by n.nspname, c.relname, p.polname
    `);

    return result.rows.map((r) => {
      const cmd = asStr(r.command);
      const command: PolicyDef['command'] =
        cmd === 'SELECT' || cmd === 'INSERT' || cmd === 'UPDATE' || cmd === 'DELETE' ? cmd : 'ALL';

      return {
        name: asStr(r.name),
        schema: asStr(r.schema),
        table: asStr(r.table_name),
        command,
        permissive: asBool(r.permissive),
        roles: asStrArray(r.roles),
        usingExpr: asNullableStr(r.using_expr),
        checkExpr: asNullableStr(r.check_expr),
      } satisfies PolicyDef;
    });
  }

  /**
   * Privilege grants to Supabase's built-in roles.
   *
   * Restricted to `anon`/`authenticated`/`service_role` on purpose. Those are the
   * grants that determine whether the destination's PostgREST API behaves like the
   * source's; grants to bespoke roles that do not exist on the destination would
   * simply fail, so they are left out rather than generating noisy errors.
   */
  async grants(schemas: readonly string[]): Promise<readonly GrantDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        n.nspname as schema,
        c.relname as object_name,
        case c.relkind when 'S' then 'sequence' else 'table' end as object_kind,
        g.grantee,
        array_agg(distinct g.privilege_type) as privileges
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      cross join lateral (
        select pg_catalog.pg_get_userbyid(a.grantee) as grantee, a.privilege_type
      ) g
      where n.nspname in ${inList(schemas)}
        and c.relkind in ('r', 'p', 'v', 'm', 'S')
        and g.grantee in ('anon', 'authenticated', 'service_role')
      group by n.nspname, c.relname, c.relkind, g.grantee
      order by n.nspname, c.relname, g.grantee
    `);

    return result.rows.map((r) => {
      const kindRaw = asStr(r.object_kind);
      return {
        schema: asStr(r.schema),
        objectName: asStr(r.object_name),
        objectKind: kindRaw === 'sequence' ? 'sequence' : 'table',
        grantee: asStr(r.grantee),
        privileges: asStrArray(r.privileges),
      } satisfies GrantDef;
    });
  }

  /** Publications — this is how Realtime knows which tables to broadcast. */
  async publications(): Promise<readonly PublicationDef[]> {
    const result = await this.transport.query<Record<string, unknown>>(`
      select
        p.pubname as name,
        p.puballtables as all_tables,
        p.pubinsert as ins,
        p.pubupdate as upd,
        p.pubdelete as del,
        p.pubtruncate as trunc,
        coalesce(
          (select jsonb_agg(jsonb_build_object('schema', pt.schemaname, 'table', pt.tablename))
           from pg_catalog.pg_publication_tables pt
           where pt.pubname = p.pubname),
          '[]'::jsonb
        ) as tables
      from pg_catalog.pg_publication p
      order by p.pubname
    `);

    return result.rows.map((r) => {
      const raw = r.tables;
      const parsed = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? [])) as readonly Record<string, unknown>[];

      return {
        name: asStr(r.name),
        allTables: asBool(r.all_tables),
        insert: asBool(r.ins),
        update: asBool(r.upd),
        delete: asBool(r.del),
        truncate: asBool(r.trunc),
        tables: Array.isArray(parsed)
          ? parsed.map((t) => ({ schema: asStr(t.schema), table: asStr(t.table) }))
          : [],
      } satisfies PublicationDef;
    });
  }

  /** Exact row count for one table. Used by validation, where an estimate will not do. */
  async countRows(schema: string, table: string): Promise<number> {
    const result = await this.transport.query<{ n: unknown }>(
      `select count(*)::text as n from ${quoteQualified(schema, table)}`,
    );
    return asNum(result.rows[0]?.n);
  }

  /**
   * Reads the whole database structure in one pass.
   *
   * The per-object queries are independent, so they run concurrently — on a
   * 1000-table database this is the difference between a discovery step that takes
   * a second and one that takes ten.
   */
  async introspect(schemas: readonly string[]): Promise<DatabaseSchema> {
    const [schemaDefs, extensions, types, sequences, tables, views, routines, triggers, policies, grants, publications] =
      await Promise.all([
        this.schemas(),
        this.extensions(),
        this.types(schemas),
        this.sequences(schemas),
        this.tables(schemas),
        this.views(schemas),
        this.routines(schemas),
        this.triggers(schemas),
        this.policies(schemas),
        this.grants(schemas).catch(() => [] as readonly GrantDef[]),
        this.publications().catch(() => [] as readonly PublicationDef[]),
      ]);

    return { schemas: schemaDefs, extensions, types, sequences, tables, views, routines, triggers, policies, grants, publications };
  }
}
