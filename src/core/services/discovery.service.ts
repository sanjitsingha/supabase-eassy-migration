/**
 * @file Step 2: discovery.
 *
 * Builds the complete inventory of a source project. Everything runs concurrently
 * and every optional part degrades to a warning rather than an error — a project
 * with Storage disabled must still be discoverable, and a missing Personal Access
 * Token should cost you the Edge Functions count, not the whole step.
 *
 * The result is also what Step 4 plans against: task lists, progress totals and ETA
 * all derive from these numbers.
 */

import type {
  BucketDef,
  DatabaseSchema,
  DiscoveryReport,
  EdgeFunctionDef,
  SupabaseCredentials,
  TransportKind,
} from '@/core/domain/types';
import { REALTIME_PUBLICATION, SYSTEM_SCHEMAS } from '@/core/domain/constants';
import { connectTransport } from '@/core/transport/transports';
import { parseProjectRef } from '@/core/transport/http';
import { IntrospectionRepository } from '@/core/repositories/introspection.repository';
import { StorageRepository } from '@/core/repositories/storage.repository';
import { AuthRepository } from '@/core/repositories/auth.repository';
import { EdgeFunctionRepository } from '@/core/repositories/edge-function.repository';

export interface DiscoveryResult {
  readonly report: DiscoveryReport;
  /** The full introspected schema, cached so Step 4 need not re-read it. */
  readonly schema: DatabaseSchema;
}

/**
 * Which schemas a migration should touch.
 *
 * Everything that is not a Postgres internal — so `public`, every custom schema the
 * user created, and the managed Supabase schemas (`auth`, `storage`, …), which are
 * included because we migrate their *data* even though we never touch their DDL.
 * This is what "do not only migrate public" means in practice.
 */
export function migratableSchemas(schema: DatabaseSchema, include: readonly string[], exclude: readonly string[]): string[] {
  const system = new Set<string>(SYSTEM_SCHEMAS);

  return schema.schemas
    .map((s) => s.name)
    .filter((name) => !system.has(name))
    .filter((name) => (include.length === 0 ? true : include.includes(name)))
    .filter((name) => !exclude.includes(name));
}

export async function discover(creds: SupabaseCredentials): Promise<DiscoveryResult> {
  const transport = await connectTransport(creds);
  const warnings: string[] = [];

  try {
    const introspection = new IntrospectionRepository(transport);
    const storage = new StorageRepository(creds, transport);
    const auth = new AuthRepository(creds, transport);
    const edge = new EdgeFunctionRepository(creds);

    // Read every non-system schema, so custom schemas are included by default.
    const schemaList = await introspection.schemas();
    const schemaNames = schemaList
      .map((s) => s.name)
      .filter((name) => !(SYSTEM_SCHEMAS as readonly string[]).includes(name));

    const [schema, postgresVersion, supabaseVersion, databaseBytes, buckets, authUsers, edgeFunctions] =
      await Promise.all([
        introspection.introspect(schemaNames),
        introspection.postgresVersion().catch(() => ''),
        introspection.supabaseVersion().catch(() => null),
        introspection.databaseSizeBytes().catch(() => 0),
        storage.listBuckets().catch((err: unknown) => {
          warnings.push(`Storage could not be read: ${err instanceof Error ? err.message : String(err)}`);
          return [] as readonly BucketDef[];
        }),
        auth.countUsers().catch(() => 0),
        edge.list().catch((err: unknown) => {
          warnings.push(`Edge Functions could not be read: ${err instanceof Error ? err.message : String(err)}`);
          return [] as readonly EdgeFunctionDef[];
        }),
      ]);

    if (!edge.available && edge.unavailableReason !== null) {
      warnings.push(edge.unavailableReason);
    }

    // Size each bucket. Concurrent, because a project may have dozens.
    const bucketStats = await Promise.all(
      buckets.map(async (bucket) => {
        const stats = await storage.bucketStats(bucket.id).catch(() => ({ count: 0, bytes: 0 }));
        return { ...bucket, objectCount: stats.count, bytes: stats.bytes };
      }),
    );

    const realtimePublication = schema.publications.find((p) => p.name === REALTIME_PUBLICATION);
    const realtimeTables = realtimePublication?.allTables === true
      ? schema.tables.length
      : (realtimePublication?.tables.length ?? 0);

    // Per-schema breakdown for the discovery UI. Managed schemas are shown so the
    // user can see that auth/storage were found, with a badge explaining that only
    // their data moves.
    const breakdown = schemaList
      .filter((s) => !(SYSTEM_SCHEMAS as readonly string[]).includes(s.name))
      .map((s) => {
        const tables = schema.tables.filter((t) => t.schema === s.name);
        return {
          schema: s.name,
          managed: s.managed,
          tables: tables.length,
          rows: tables.reduce((sum, t) => sum + t.estimatedRows, 0),
          bytes: tables.reduce((sum, t) => sum + t.totalBytes, 0),
        };
      })
      .filter((s) => s.tables > 0 || !s.managed)
      .sort((a, b) => b.bytes - a.bytes);

    const userTables = schema.tables.filter((t) => !isManaged(schemaList, t.schema));

    const report: DiscoveryReport = {
      generatedAt: new Date().toISOString(),
      projectRef: parseProjectRef(creds.url),
      instanceType: creds.type,
      supabaseVersion,
      postgresVersion: extractVersion(postgresVersion),
      transport: transport.kind as TransportKind,
      counts: {
        schemas: breakdown.length,
        tables: userTables.length,
        views: schema.views.filter((v) => !v.materialized && !isManaged(schemaList, v.schema)).length,
        materializedViews: schema.views.filter((v) => v.materialized && !isManaged(schemaList, v.schema)).length,
        functions: schema.routines.filter((r) => !isManaged(schemaList, r.schema)).length,
        triggers: schema.triggers.filter((t) => !isManaged(schemaList, t.schema)).length,
        policies: schema.policies.length,
        extensions: schema.extensions.length,
        sequences: schema.sequences.filter((s) => !isManaged(schemaList, s.schema)).length,
        types: schema.types.filter((t) => !isManaged(schemaList, t.schema)).length,
        buckets: bucketStats.length,
        files: bucketStats.reduce((sum, b) => sum + b.objectCount, 0),
        authUsers,
        edgeFunctions: edgeFunctions.length,
        estimatedRows: userTables.reduce((sum, t) => sum + t.estimatedRows, 0),
      },
      storageBytes: bucketStats.reduce((sum, b) => sum + b.bytes, 0),
      databaseBytes,
      realtimeEnabled: realtimePublication !== undefined,
      realtimeTables,
      schemaBreakdown: breakdown,
      buckets: bucketStats,
      edgeFunctions,
      warnings,
    };

    return { report, schema };
  } finally {
    await transport.dispose();
  }
}

function isManaged(schemas: readonly { name: string; managed: boolean }[], name: string): boolean {
  return schemas.find((s) => s.name === name)?.managed === true;
}

/** `PostgreSQL 15.8 on aarch64-...` -> `15.8`. */
function extractVersion(raw: string): string | null {
  if (raw === '') return null;
  const match = /PostgreSQL (\d+(?:\.\d+)?)/.exec(raw);
  return match?.[1] ?? raw;
}
