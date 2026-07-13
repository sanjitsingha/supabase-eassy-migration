/**
 * @file Turns the introspected model back into executable DDL.
 *
 * Split into ordered *phases* rather than one big script, because the order in
 * which Postgres objects can be created is a real constraint, not a stylistic
 * one. Tables cannot reference types that do not exist; foreign keys cannot
 * reference tables that do not exist; triggers cannot reference functions that do
 * not exist. Getting this wrong is the difference between a migration that works
 * and one that fails on table 3 of 900.
 *
 * The order is:
 *
 *   1. schemas      — nothing else can be created without them
 *   2. extensions   — types like `vector` or `postgis` come from here
 *   3. types        — enums/composites/domains used by table columns
 *   4. sequences    — referenced by column defaults
 *   5. tables       — columns + PK/unique/check, but **no foreign keys yet**
 *   6. functions    — before triggers (which call them) and before views/policies
 *                     (whose definitions may reference them)
 *   7. foreign keys — now that every table exists, in any order
 *   8. indexes      — after data would be faster, but correctness first; see below
 *   9. views        — topologically sorted, since views select from views
 *  10. triggers     — the functions they call now exist
 *  11. policies     — the functions they call now exist
 *  12. grants
 *
 * Splitting tables from their foreign keys (5 vs 7) is what removes the need to
 * topologically sort tables at all, and it is the only approach that survives
 * *circular* FK references, which a topological sort cannot express.
 */

import type {
  DatabaseSchema,
  ExtensionDef,
  GrantDef,
  PolicyDef,
  RoutineDef,
  SequenceDef,
  TableDef,
  TriggerDef,
  TypeDef,
  ViewDef,
} from '@/core/domain/types';
import { MANAGED_EXTENSIONS, MANAGED_SCHEMAS } from '@/core/domain/constants';
import { quoteIdent, quoteLiteral, quoteQualified } from '@/core/transport/sql';

/** One executable statement, tagged so failures can be reported against an object. */
export interface DdlStatement {
  /** e.g. `public.orders`, or `public.orders.orders_user_id_fkey`. */
  readonly object: string;
  readonly sql: string;
}

export type DdlPhase =
  | 'schemas'
  | 'extensions'
  | 'types'
  | 'sequences'
  | 'tables'
  | 'functions'
  | 'foreign_keys'
  | 'indexes'
  | 'views'
  | 'triggers'
  | 'policies'
  | 'grants'
  | 'sequence_values';

const MANAGED = new Set<string>(MANAGED_SCHEMAS);
const MANAGED_EXT = new Set<string>(MANAGED_EXTENSIONS);

/** True when this schema's DDL belongs to the platform and must not be replayed. */
export function isManagedSchema(schema: string): boolean {
  return MANAGED.has(schema);
}

// ---------------------------------------------------------------------------
// Phase builders
// ---------------------------------------------------------------------------

export function buildSchemas(schema: DatabaseSchema): DdlStatement[] {
  return schema.schemas
    .filter((s) => !s.managed && s.name !== 'public')
    .flatMap((s) => {
      const statements: DdlStatement[] = [
        { object: s.name, sql: `create schema if not exists ${quoteIdent(s.name)};` },
      ];
      if (s.comment !== null) {
        statements.push({
          object: s.name,
          sql: `comment on schema ${quoteIdent(s.name)} is ${quoteLiteral(s.comment)};`,
        });
      }
      return statements;
    });
}

export function buildExtensions(extensions: readonly ExtensionDef[]): DdlStatement[] {
  return extensions
    .filter((e) => !MANAGED_EXT.has(e.name))
    .map((e) => ({
      object: e.name,
      // No version pin: the destination may not have the source's exact version
      // available, and pinning would fail where an unpinned create succeeds.
      sql: `create extension if not exists ${quoteIdent(e.name)} with schema ${quoteIdent(e.schema)};`,
    }));
}

export function buildTypes(types: readonly TypeDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const type of types) {
    if (isManagedSchema(type.schema)) continue;
    const name = quoteQualified(type.schema, type.name);
    const object = `${type.schema}.${type.name}`;

    switch (type.kind) {
      case 'enum': {
        if (type.enumLabels.length === 0) break;
        const labels = type.enumLabels.map(quoteLiteral).join(', ');
        // `do $$ ... exception when duplicate_object` because Postgres has no
        // `create type if not exists`, and a re-run must not blow up.
        statements.push({
          object,
          sql: `do $nbk$ begin create type ${name} as enum (${labels}); exception when duplicate_object then null; end $nbk$;`,
        });
        break;
      }
      case 'composite': {
        if (type.attributes.length === 0) break;
        const attrs = type.attributes.map((a) => `${quoteIdent(a.name)} ${a.type}`).join(', ');
        statements.push({
          object,
          sql: `do $nbk$ begin create type ${name} as (${attrs}); exception when duplicate_object then null; end $nbk$;`,
        });
        break;
      }
      case 'domain': {
        if (type.domainBase === null) break;
        const parts = [`create domain ${name} as ${type.domainBase}`];
        if (type.domainDefault !== null) parts.push(`default ${type.domainDefault}`);
        if (type.domainNotNull) parts.push('not null');
        for (const check of type.domainChecks) parts.push(check);
        statements.push({
          object,
          sql: `do $nbk$ begin ${parts.join(' ')}; exception when duplicate_object then null; end $nbk$;`,
        });
        break;
      }
      case 'range':
        // Ranges need their subtype's operator class, which we do not introspect.
        // Emitting a guessed CREATE TYPE would be worse than skipping and warning.
        break;
    }

    if (type.comment !== null) {
      const keyword = type.kind === 'domain' ? 'domain' : 'type';
      statements.push({ object, sql: `comment on ${keyword} ${name} is ${quoteLiteral(type.comment)};` });
    }
  }

  return statements;
}

/**
 * Sequences.
 *
 * Only *identity*-owned sequences are skipped, because `CREATE TABLE ... GENERATED
 * AS IDENTITY` creates those itself and a second `CREATE SEQUENCE` would be a
 * duplicate.
 *
 * A `serial` column's sequence, by contrast, **must** be created here. We emit serial
 * columns the way the catalog reports them — a plain `bigint DEFAULT
 * nextval('t_id_seq')` — so nothing else brings the sequence into existence, and the
 * `CREATE TABLE` fails with `relation "t_id_seq" does not exist`. Ownership is
 * re-attached in {@link buildSequenceValues}, once the table it belongs to exists.
 */
export function buildSequences(sequences: readonly SequenceDef[]): DdlStatement[] {
  return sequences
    .filter((s) => !isManagedSchema(s.schema) && !s.ownedByIdentity)
    .map((s) => ({
      object: `${s.schema}.${s.name}`,
      sql:
        [
          `create sequence if not exists ${quoteQualified(s.schema, s.name)}`,
          `as ${s.dataType}`,
          `increment by ${s.incrementBy}`,
          `minvalue ${s.minValue}`,
          `maxvalue ${s.maxValue}`,
          `start with ${s.startValue}`,
          `cache ${s.cacheSize}`,
          s.cycles ? 'cycle' : 'no cycle',
        ].join(' ') + ';',
    }));
}

/**
 * Replays `setval` so the destination's sequences continue where the source's left
 * off.
 *
 * This runs *after* data. Copying rows with explicit ids does not advance a
 * sequence, so without this the first `INSERT` your application makes after the
 * migration would try to reuse id 1 and hit a unique violation. It is the single
 * most commonly forgotten step in a hand-rolled Supabase migration.
 */
export function buildSequenceValues(sequences: readonly SequenceDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const sequence of sequences) {
    if (isManagedSchema(sequence.schema)) continue;
    const object = `${sequence.schema}.${sequence.name}`;
    const name = quoteQualified(sequence.schema, sequence.name);

    // Re-attach a serial sequence to its column. This is what makes the destination's
    // `serial` behave like the source's: the sequence is dropped with the table, and
    // `pg_get_serial_sequence` resolves. Identity sequences are already owned by
    // construction, and Postgres rejects an explicit OWNED BY on them.
    if (sequence.ownedBy !== null && !sequence.ownedByIdentity) {
      statements.push({
        object,
        sql: `alter sequence ${name} owned by ${quoteQualified(sequence.ownedBy.schema, sequence.ownedBy.table)}.${quoteIdent(sequence.ownedBy.column)};`,
      });
    }

    // Advance the sequence past the rows we just copied. Applies to identity and
    // serial sequences alike: inserting rows with explicit ids does not move the
    // sequence, so without this the application's next insert collides with an id
    // that already exists.
    if (sequence.lastValue !== null) {
      statements.push({
        object,
        sql: `select setval(${quoteLiteral(`${quoteIdent(sequence.schema)}.${quoteIdent(sequence.name)}`)}, ${sequence.lastValue}, true);`,
      });
    }
  }

  return statements;
}

/**
 * `CREATE TABLE` with columns and every constraint *except* foreign keys.
 *
 * Foreign keys are deferred to their own phase so that table creation order never
 * matters — which in turn means circular references (A→B and B→A) work, where a
 * topological sort would deadlock.
 */
export function buildTables(tables: readonly TableDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const table of tables) {
    if (isManagedSchema(table.schema)) continue;
    if (table.kind === 'foreign') continue; // Foreign tables need their server/FDW; out of scope.

    const object = `${table.schema}.${table.name}`;
    const name = quoteQualified(table.schema, table.name);

    // A partition is created by attaching it to its parent, not as a standalone table.
    if (table.parentTable !== null && table.partitionExpr !== null) {
      const [parentSchema = '', parentName = ''] = table.parentTable.split('.');
      statements.push({
        object,
        sql: `create table if not exists ${name} partition of ${quoteQualified(parentSchema, parentName)} ${table.partitionExpr};`,
      });
      continue;
    }

    const parts: string[] = [];

    for (const column of table.columns) {
      parts.push(buildColumn(column));
    }

    for (const constraint of table.constraints) {
      if (constraint.kind === 'f') continue; // Deferred to the foreign_keys phase.
      parts.push(`constraint ${quoteIdent(constraint.name)} ${constraint.definition}`);
    }

    const partitionClause = table.kind === 'partitioned' && table.partitionExpr !== null
      ? ` partition by ${table.partitionExpr}`
      : '';

    statements.push({
      object,
      sql: `create table if not exists ${name} (\n  ${parts.join(',\n  ')}\n)${partitionClause};`,
    });

    if (table.rlsEnabled) {
      statements.push({ object, sql: `alter table ${name} enable row level security;` });
    }
    if (table.rlsForced) {
      statements.push({ object, sql: `alter table ${name} force row level security;` });
    }
    if (table.comment !== null) {
      statements.push({ object, sql: `comment on table ${name} is ${quoteLiteral(table.comment)};` });
    }
    for (const column of table.columns) {
      if (column.comment !== null) {
        statements.push({
          object,
          sql: `comment on column ${name}.${quoteIdent(column.name)} is ${quoteLiteral(column.comment)};`,
        });
      }
    }
  }

  return statements;
}

function buildColumn(column: ColumnLike): string {
  const parts = [quoteIdent(column.name), column.dataType];

  if (column.collation !== null) parts.push(`collate ${column.collation}`);

  if (column.generatedExpr !== null) {
    // A stored generated column takes no default and no null constraint.
    parts.push(`generated always as (${column.generatedExpr}) stored`);
  } else if (column.identity !== null) {
    parts.push(`generated ${column.identity.toLowerCase()} as identity`);
  } else if (column.defaultExpr !== null) {
    parts.push(`default ${column.defaultExpr}`);
  }

  if (!column.isNullable && column.generatedExpr === null) parts.push('not null');

  return parts.join(' ');
}

interface ColumnLike {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly defaultExpr: string | null;
  readonly identity: 'ALWAYS' | 'BY DEFAULT' | null;
  readonly generatedExpr: string | null;
  readonly collation: string | null;
}

/** Foreign keys, added once every table exists. */
export function buildForeignKeys(tables: readonly TableDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const table of tables) {
    if (isManagedSchema(table.schema)) continue;
    const name = quoteQualified(table.schema, table.name);

    for (const constraint of table.constraints) {
      if (constraint.kind !== 'f') continue;
      statements.push({
        object: `${table.schema}.${table.name}.${constraint.name}`,
        // Wrapped so that re-running a partially-completed migration does not fail
        // on constraints that already landed. Postgres has no
        // `add constraint if not exists`.
        sql: `do $nbk$ begin alter table ${name} add constraint ${quoteIdent(constraint.name)} ${constraint.definition}; exception when duplicate_object then null; when duplicate_table then null; end $nbk$;`,
      });
    }
  }

  return statements;
}

/** Standalone indexes — the ones not already created by a constraint. */
export function buildIndexes(tables: readonly TableDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const table of tables) {
    if (isManagedSchema(table.schema)) continue;

    for (const index of table.indexes) {
      if (index.isConstraintBacked) continue;
      // `pg_get_indexdef` emits `CREATE [UNIQUE] INDEX name ON tbl ...`. Splice in
      // `IF NOT EXISTS` so a resumed migration is idempotent.
      const sql = index.definition.replace(/^CREATE (UNIQUE )?INDEX /i, (_m, unique: string | undefined) =>
        `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `,
      );
      statements.push({ object: `${table.schema}.${table.name}.${index.name}`, sql: `${sql};` });
    }
  }

  return statements;
}

export function buildFunctions(routines: readonly RoutineDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const routine of routines) {
    if (isManagedSchema(routine.schema)) continue;
    if (routine.kind === 'aggregate' || routine.kind === 'window') continue; // No pg_get_functiondef.

    const object = `${routine.schema}.${routine.name}(${routine.identityArgs})`;
    // pg_get_functiondef already emits CREATE OR REPLACE, so this is re-runnable.
    statements.push({ object, sql: `${routine.definition};` });

    if (routine.comment !== null) {
      statements.push({
        object,
        sql: `comment on function ${quoteQualified(routine.schema, routine.name)}(${routine.identityArgs}) is ${quoteLiteral(routine.comment)};`,
      });
    }
  }

  return statements;
}

/**
 * Views, topologically sorted so a view is created after everything it selects from.
 *
 * `pg_get_viewdef` gives us the body; we prepend our own `CREATE OR REPLACE VIEW`
 * header, preserving `security_invoker` (which Supabase relies on to make views
 * respect the caller's RLS rather than the definer's).
 */
export function buildViews(views: readonly ViewDef[]): DdlStatement[] {
  const eligible = views.filter((v) => !isManagedSchema(v.schema));
  const sorted = topoSortViews(eligible);
  const statements: DdlStatement[] = [];

  for (const view of sorted) {
    const object = `${view.schema}.${view.name}`;
    const name = quoteQualified(view.schema, view.name);

    if (view.materialized) {
      statements.push({
        object,
        sql: `create materialized view if not exists ${name} as\n${view.definition}`,
      });
    } else {
      const options = view.isSecurityInvoker ? ' with (security_invoker = true)' : '';
      statements.push({
        object,
        sql: `create or replace view ${name}${options} as\n${view.definition}`,
      });
    }

    if (view.comment !== null) {
      const keyword = view.materialized ? 'materialized view' : 'view';
      statements.push({ object, sql: `comment on ${keyword} ${name} is ${quoteLiteral(view.comment)};` });
    }
  }

  return statements;
}

/**
 * Orders views so dependencies come first.
 *
 * A plain Kahn's algorithm, with one deliberate concession: if a cycle is detected
 * (which Postgres does not actually allow between views, but which our
 * `pg_depend`-derived edges could still produce through a table alias) the
 * remaining views are emitted anyway rather than dropped. A view that fails to
 * create is a logged, recoverable error; a view silently omitted from the
 * migration is a data-integrity bug the user would not notice.
 */
function topoSortViews(views: readonly ViewDef[]): ViewDef[] {
  const byKey = new Map(views.map((v) => [`${v.schema}.${v.name}`, v]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: ViewDef[] = [];

  const visit = (key: string): void => {
    if (visited.has(key) || visiting.has(key)) return;
    const view = byKey.get(key);
    if (!view) return; // Depends on a table, not a view — nothing to order.

    visiting.add(key);
    for (const dep of view.dependsOn) {
      if (dep !== key) visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
    sorted.push(view);
  };

  for (const view of views) visit(`${view.schema}.${view.name}`);

  // Anything a cycle prevented us from emitting still gets emitted.
  for (const view of views) {
    if (!visited.has(`${view.schema}.${view.name}`)) sorted.push(view);
  }

  return sorted;
}

export function buildTriggers(triggers: readonly TriggerDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const trigger of triggers) {
    if (isManagedSchema(trigger.schema)) continue;

    const object = `${trigger.schema}.${trigger.table}.${trigger.name}`;
    const table = quoteQualified(trigger.schema, trigger.table);

    // No `create or replace trigger` before PG14, so drop-then-create is the
    // portable idempotent form.
    statements.push({ object, sql: `drop trigger if exists ${quoteIdent(trigger.name)} on ${table};` });
    statements.push({ object, sql: `${trigger.definition};` });

    // 'D' = disabled. Preserve that rather than silently enabling it.
    if (trigger.enabledState === 'D') {
      statements.push({
        object,
        sql: `alter table ${table} disable trigger ${quoteIdent(trigger.name)};`,
      });
    }
  }

  return statements;
}

/** RLS policies. Postgres has no `pg_get_policydef`, so this is fully hand-built. */
export function buildPolicies(policies: readonly PolicyDef[]): DdlStatement[] {
  const statements: DdlStatement[] = [];

  for (const policy of policies) {
    if (isManagedSchema(policy.schema)) continue;

    const object = `${policy.schema}.${policy.table}.${policy.name}`;
    const table = quoteQualified(policy.schema, policy.table);
    const parts = [
      `create policy ${quoteIdent(policy.name)} on ${table}`,
      `as ${policy.permissive ? 'permissive' : 'restrictive'}`,
      `for ${policy.command.toLowerCase()}`,
      `to ${policy.roles.map((r) => (r === 'public' ? 'public' : quoteIdent(r))).join(', ')}`,
    ];

    if (policy.usingExpr !== null) parts.push(`using (${policy.usingExpr})`);
    if (policy.checkExpr !== null) parts.push(`with check (${policy.checkExpr})`);

    statements.push({ object, sql: `drop policy if exists ${quoteIdent(policy.name)} on ${table};` });
    statements.push({ object, sql: `${parts.join(' ')};` });
  }

  return statements;
}

export function buildGrants(grants: readonly GrantDef[]): DdlStatement[] {
  return grants
    .filter((g) => !isManagedSchema(g.schema))
    .map((g) => ({
      object: `${g.schema}.${g.objectName}`,
      sql: `grant ${g.privileges.join(', ')} on ${g.objectKind === 'sequence' ? 'sequence ' : ''}${quoteQualified(g.schema, g.objectName)} to ${quoteIdent(g.grantee)};`,
    }));
}

// ---------------------------------------------------------------------------
// Phase assembly
// ---------------------------------------------------------------------------

/**
 * Phases applied *before* the data copy.
 *
 * Everything here is a prerequisite for inserting a row: the table itself, the
 * types its columns use, the sequences its defaults call.
 */
export const PRE_DATA_PHASES: readonly DdlPhase[] = [
  'schemas',
  'extensions',
  'types',
  'sequences',
  'tables',
  'functions',
];

/**
 * Phases applied *after* the data copy — and it is a deliberate, load-bearing
 * choice that foreign keys, indexes and triggers land here rather than up front.
 * This is the same pre-data/data/post-data split `pg_restore` uses, and it buys
 * three things that matter enormously at scale:
 *
 * - **Tables can be copied in parallel, in any order.** With no FK constraints in
 *   place during the copy there is nothing to violate, so `orders` can be loaded
 *   before `users` exists. Any other approach needs a topological sort of the
 *   tables, and still breaks on circular references.
 * - **Inserts do not pay index-maintenance cost.** Building an index once over a
 *   finished table is dramatically cheaper than incrementally updating it a
 *   million times. On a large table this is most of the wall-clock saving.
 * - **Triggers do not fire during the copy.** Otherwise an `on insert` trigger
 *   that writes an audit row or sends a webhook would fire once per migrated
 *   row — duplicating data that the copy is itself about to migrate.
 *
 * Materialised views are here too, so that they populate from data that is
 * actually present. `sequence_values` is last, so `setval` sees the final state.
 */
export const POST_DATA_PHASES: readonly DdlPhase[] = [
  'foreign_keys',
  'indexes',
  'views',
  'triggers',
  'policies',
  'grants',
  'sequence_values',
];

/** Every phase's statements, keyed by phase. Iteration order is application order. */
export function buildPhases(schema: DatabaseSchema): ReadonlyMap<DdlPhase, readonly DdlStatement[]> {
  return new Map<DdlPhase, readonly DdlStatement[]>([
    ['schemas', buildSchemas(schema)],
    ['extensions', buildExtensions(schema.extensions)],
    ['types', buildTypes(schema.types)],
    ['sequences', buildSequences(schema.sequences)],
    ['tables', buildTables(schema.tables)],
    ['functions', buildFunctions(schema.routines)],
    ['foreign_keys', buildForeignKeys(schema.tables)],
    ['indexes', buildIndexes(schema.tables)],
    ['views', buildViews(schema.views)],
    ['triggers', buildTriggers(schema.triggers)],
    ['policies', buildPolicies(schema.policies)],
    ['grants', buildGrants(schema.grants)],
    ['sequence_values', buildSequenceValues(schema.sequences)],
  ]);
}

/** Maps a DDL phase onto the Step-3 checkbox that controls it. */
export function phaseStage(phase: DdlPhase): 'extensions' | 'tables' | 'functions' | 'views' | 'triggers' | 'policies' {
  switch (phase) {
    case 'extensions':
      return 'extensions';
    case 'functions':
      return 'functions';
    case 'views':
      return 'views';
    case 'triggers':
      return 'triggers';
    case 'policies':
      return 'policies';
    default:
      // schemas / types / sequences / tables / foreign_keys / indexes / grants /
      // sequence_values are all structural prerequisites of "Tables".
      return 'tables';
  }
}
