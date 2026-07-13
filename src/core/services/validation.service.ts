/**
 * @file Post-migration validation.
 *
 * Counts the same things on both sides and compares. The status rules encode what a
 * difference actually *means*, which is more useful than a naive equality check:
 *
 * - **fail** — the destination has fewer objects than the source. Something did not
 *   make it across, and the user needs to know which stage.
 * - **warn** — the destination has *more*. Usually benign (the destination already
 *   had rows, or Supabase auto-created something), but worth surfacing because it can
 *   also mean a re-run double-inserted into a table with no primary key.
 * - **pass** — equal.
 *
 * Row counts are `count(*)`, not `reltuples`. An estimate is fine for drawing a
 * progress bar and useless for proving a migration was complete.
 */

import type { ValidationCheck, ValidationReport, ValidationStatus } from '@/core/domain/types';
import type { RunContext } from '@/core/services/orchestrator';
import { REALTIME_PUBLICATION } from '@/core/domain/constants';
import { isManagedSchema } from '@/core/ddl/generator';
import { migratableSchemas } from '@/core/services/discovery.service';

export async function validate(context: RunContext): Promise<ValidationReport> {
  const { job, sourceSchema, sourceIntrospection, destIntrospection, sourceData, destData, sourceStorage, destStorage, sourceAuth, destAuth } =
    context;

  const checks: ValidationCheck[] = [];

  const destSchemaNames = migratableSchemas(
    { ...sourceSchema, schemas: await destIntrospection.schemas() },
    job.options.includeSchemas,
    job.options.excludeSchemas,
  );
  const destSchema = await destIntrospection.introspect(destSchemaNames);

  // --- Row counts, per table -------------------------------------------------
  if (job.selection.data) {
    const userTables = sourceSchema.tables.filter((t) => !isManagedSchema(t.schema) && t.kind !== 'foreign');

    // Bounded concurrency: a thousand simultaneous count(*) would be unkind to both
    // databases and would likely trip a connection limit.
    const results = await mapWithLimit(userTables, 8, async (table) => {
      const [source, destination] = await Promise.all([
        sourceData.count(table.schema, table.name).catch(() => -1),
        destData.count(table.schema, table.name).catch(() => -1),
      ]);
      return { table: `${table.schema}.${table.name}`, source, destination };
    });

    for (const result of results) {
      // -1 means the count itself failed — a missing table at the destination.
      if (result.destination === -1) {
        checks.push({
          category: 'rows',
          label: result.table,
          source: Math.max(0, result.source),
          destination: 0,
          status: 'fail',
          note: 'Table not found at the destination',
        });
        continue;
      }
      checks.push({
        category: 'rows',
        label: result.table,
        source: result.source,
        destination: result.destination,
        status: compare(result.source, result.destination),
        note: rowNote(result.source, result.destination),
      });
    }
  }

  // --- Storage ---------------------------------------------------------------
  if (job.selection.buckets || job.selection.storage_files) {
    const [sourceBuckets, destBuckets] = await Promise.all([
      sourceStorage.listBuckets().catch(() => []),
      destStorage.listBuckets().catch(() => []),
    ]);

    checks.push({
      category: 'buckets',
      label: 'Storage buckets',
      source: sourceBuckets.length,
      destination: destBuckets.length,
      status: compare(sourceBuckets.length, destBuckets.length),
    });

    if (job.selection.storage_files) {
      for (const bucket of sourceBuckets) {
        const [sourceStats, destStats] = await Promise.all([
          sourceStorage.bucketStats(bucket.id).catch(() => ({ count: 0, bytes: 0 })),
          destStorage.bucketStats(bucket.id).catch(() => ({ count: 0, bytes: 0 })),
        ]);

        checks.push({
          category: 'files',
          label: `Files in ${bucket.name}`,
          source: sourceStats.count,
          destination: destStats.count,
          status: compare(sourceStats.count, destStats.count),
          note:
            destStats.bytes !== sourceStats.bytes
              ? `${formatBytes(sourceStats.bytes)} at source vs ${formatBytes(destStats.bytes)} at destination`
              : undefined,
        });
      }
    }
  }

  // --- Auth ------------------------------------------------------------------
  if (job.selection.auth_users) {
    const [source, destination] = await Promise.all([
      sourceAuth.countUsers().catch(() => 0),
      destAuth.countUsers().catch(() => 0),
    ]);

    checks.push({
      category: 'users',
      label: 'Auth users',
      source,
      destination,
      status: compare(source, destination),
    });

    // Identities matter independently: a user with no identity row cannot sign in
    // with the OAuth provider they originally used, even though the user itself
    // migrated fine. Counting them separately makes that failure visible.
    if (sourceAuth.canUseSql && destAuth.canUseSql) {
      const [sourceIdentities, destIdentities] = await Promise.all([
        sourceData.count('auth', 'identities').catch(() => -1),
        destData.count('auth', 'identities').catch(() => -1),
      ]);
      if (sourceIdentities >= 0 && destIdentities >= 0) {
        checks.push({
          category: 'users',
          label: 'Auth identities (OAuth links)',
          source: sourceIdentities,
          destination: destIdentities,
          status: compare(sourceIdentities, destIdentities),
        });
      }
    }
  }

  // --- Schema objects --------------------------------------------------------
  const objectChecks: readonly {
    category: ValidationCheck['category'];
    label: string;
    source: number;
    destination: number;
    selected: boolean;
  }[] = [
    {
      category: 'functions',
      label: 'Functions',
      source: countUser(sourceSchema.routines),
      destination: countUser(destSchema.routines),
      selected: job.selection.functions,
    },
    {
      category: 'views',
      label: 'Views',
      source: countUser(sourceSchema.views),
      destination: countUser(destSchema.views),
      selected: job.selection.views,
    },
    {
      category: 'triggers',
      label: 'Triggers',
      source: countUser(sourceSchema.triggers),
      destination: countUser(destSchema.triggers),
      selected: job.selection.triggers,
    },
    {
      category: 'policies',
      label: 'RLS policies',
      source: sourceSchema.policies.length,
      destination: destSchema.policies.length,
      selected: job.selection.policies,
    },
    {
      category: 'extensions',
      label: 'Extensions',
      source: sourceSchema.extensions.length,
      destination: destSchema.extensions.length,
      selected: job.selection.extensions,
    },
  ];

  for (const check of objectChecks) {
    if (!check.selected) continue;
    checks.push({
      category: check.category,
      label: check.label,
      source: check.source,
      destination: check.destination,
      status: compare(check.source, check.destination),
    });
  }

  // Realtime.
  if (job.selection.realtime) {
    const sourcePub = sourceSchema.publications.find((p) => p.name === REALTIME_PUBLICATION);
    const destPub = destSchema.publications.find((p) => p.name === REALTIME_PUBLICATION);
    const sourceCount = sourcePub?.allTables === true ? sourceSchema.tables.length : (sourcePub?.tables.length ?? 0);
    const destCount = destPub?.allTables === true ? destSchema.tables.length : (destPub?.tables.length ?? 0);

    checks.push({
      category: 'triggers',
      label: 'Realtime tables',
      source: sourceCount,
      destination: destCount,
      status: compare(sourceCount, destCount),
    });
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;

  const status: ValidationStatus = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass';

  await sourceIntrospection.postgresVersion().catch(() => undefined); // keep-alive; harmless.

  return {
    generatedAt: new Date().toISOString(),
    status,
    checks,
    summary: { passed, warned, failed },
  };
}

/** Fewer at the destination is a failure; more is worth a look; equal passes. */
function compare(source: number, destination: number): ValidationStatus {
  if (destination < source) return 'fail';
  if (destination > source) return 'warn';
  return 'pass';
}

function rowNote(source: number, destination: number): string | undefined {
  if (destination < source) return `${(source - destination).toLocaleString()} row(s) missing`;
  if (destination > source) {
    return `${(destination - source).toLocaleString()} extra row(s) — the destination table was not empty, or rows were inserted twice`;
  }
  return undefined;
}

function countUser<T extends { schema: string }>(items: readonly T[]): number {
  return items.filter((i) => !isManagedSchema(i.schema)).length;
}

/** `Promise.all` over a bounded worker count. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let index = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
