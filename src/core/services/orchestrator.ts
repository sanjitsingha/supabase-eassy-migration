/**
 * @file The migration orchestrator.
 *
 * ## Resumability
 *
 * The whole design turns on one idea: **a migration is a list of independently
 * checkpointable tasks, and every task knows how to restart from the middle of
 * itself.** A task is a DDL phase, one table's data, one bucket's files, one auth
 * table, one edge function. Each carries a `cursor` — the last key or object path
 * it successfully wrote — and each is written back to disk the moment it advances.
 *
 * So there are two levels of resume, and both matter:
 *
 * - **Between tasks.** A completed task is never redone. Restarting a job that got
 *   through 800 of 1000 tables begins at table 801.
 * - **Within a task.** A table that died 900,000 rows into a million restarts at row
 *   900,001, because the cursor said so. This is the level most tools skip, and it is
 *   the difference between a resumable migration and one that merely *looks*
 *   resumable.
 *
 * ## Error policy
 *
 * "Never stop the entire migration." A failing unit is retried with backoff; if it
 * is still failing after `maxRetries` it is marked `failed`, logged, and the
 * migration moves on. The job ends `completed_with_errors` rather than `failed`, and
 * the validation report tells the user exactly what did not make it. The only things
 * that stop everything are an explicit cancel and a failure to connect at all.
 *
 * ## Stage order
 *
 * Pre-data DDL → data → post-data DDL → storage → auth → edge functions → realtime.
 * See `ddl/generator.ts` for why foreign keys, indexes and triggers deliberately
 * come *after* the data rather than before it.
 */

import type {
  DatabaseSchema,
  MigrationJob,
  MigrationTask,
  SqlTransport,
  StageId,
  SupabaseCredentials,
  TableDef,
} from '@/core/domain/types';
import { CancelledError, PausedError, toMigrationError } from '@/core/domain/errors';
import { DEFAULTS, MANAGED_DATA_TABLES, REALTIME_PUBLICATION } from '@/core/domain/constants';
import { connectTransport } from '@/core/transport/transports';
import { quoteQualified } from '@/core/transport/sql';
import { IntrospectionRepository } from '@/core/repositories/introspection.repository';
import { DataRepository } from '@/core/repositories/data.repository';
import { StorageRepository } from '@/core/repositories/storage.repository';
import { AuthRepository } from '@/core/repositories/auth.repository';
import { EdgeFunctionRepository } from '@/core/repositories/edge-function.repository';
import {
  buildPhases,
  phaseStage,
  POST_DATA_PHASES,
  PRE_DATA_PHASES,
  type DdlPhase,
  type DdlStatement,
} from '@/core/ddl/generator';
import { BandwidthLimiter, runPool, sleep, ThroughputMeter, withRetry } from '@/core/infra/concurrency';
import { eventBus, JobLogger } from '@/core/infra/events';
import { jobRepository } from '@/core/infra/store';
import { credentialVault } from '@/core/infra/vault';
import { migratableSchemas } from '@/core/services/discovery.service';
import { validate } from '@/core/services/validation.service';

type Control = 'run' | 'pause' | 'cancel';

/** Everything a stage needs. Built once per run and passed down. */
interface RunContext {
  readonly job: MigrationJob;
  readonly logger: JobLogger;
  readonly sourceCreds: SupabaseCredentials;
  readonly destCreds: SupabaseCredentials;
  readonly sourceSql: SqlTransport;
  readonly destSql: SqlTransport;
  readonly sourceIntrospection: IntrospectionRepository;
  readonly destIntrospection: IntrospectionRepository;
  readonly sourceData: DataRepository;
  readonly destData: DataRepository;
  readonly sourceStorage: StorageRepository;
  readonly destStorage: StorageRepository;
  readonly sourceAuth: AuthRepository;
  readonly destAuth: AuthRepository;
  readonly sourceEdge: EdgeFunctionRepository;
  readonly destEdge: EdgeFunctionRepository;
  readonly limiter: BandwidthLimiter;
  readonly meter: ThroughputMeter;
  readonly signal: () => void;
  /** The source schema, read once and reused by every stage. */
  sourceSchema: DatabaseSchema;
  /** Destination table shapes, for column intersection. Lazily filled. */
  destTables: Map<string, TableDef>;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class MigrationRunner {
  private control: Control = 'run';
  private finished: Promise<void> | null = null;

  constructor(private readonly jobId: string) {}

  /** Throws to unwind the stack the instant the user pauses or cancels. */
  private readonly signal = (): void => {
    if (this.control === 'cancel') throw new CancelledError();
    if (this.control === 'pause') throw new PausedError();
  };

  pause(): void {
    this.control = 'pause';
  }

  cancel(): void {
    this.control = 'cancel';
  }

  get isRunning(): boolean {
    return this.finished !== null && this.control === 'run';
  }

  /** Starts the migration. Returns immediately; progress arrives over the event bus. */
  start(): Promise<void> {
    this.finished ??= this.execute().catch(() => undefined);
    return this.finished;
  }

  private async execute(): Promise<void> {
    const job = await jobRepository.find(this.jobId);
    if (job === null) return;

    const logger = new JobLogger(this.jobId);
    const runStartedAt = Date.now();

    // Credentials live only in memory, so a server restart means they are gone and
    // the user must re-enter them. Fail clearly rather than mysteriously.
    let sourceCreds: SupabaseCredentials;
    let destCreds: SupabaseCredentials;
    try {
      sourceCreds = credentialVault.get(this.jobId, 'source');
      destCreds = credentialVault.get(this.jobId, 'destination');
    } catch (err) {
      const error = toMigrationError(err);
      job.status = 'paused';
      job.error = error.message;
      await this.persist(job);
      logger.error('system', error.message);
      eventBus.publish(this.jobId, { type: 'status', status: 'paused', error: error.message });
      return;
    }

    job.status = 'running';
    job.error = null;
    job.startedAt ??= new Date().toISOString();
    await this.persist(job);
    eventBus.publish(this.jobId, { type: 'status', status: 'running', error: null });

    let sourceSql: SqlTransport | null = null;
    let destSql: SqlTransport | null = null;

    try {
      logger.info('system', 'Connecting to source and destination');
      [sourceSql, destSql] = await Promise.all([connectTransport(sourceCreds), connectTransport(destCreds)]);
      logger.success('system', `Connected — source via ${sourceSql.kind}, destination via ${destSql.kind}`);

      const context: RunContext = {
        job,
        logger,
        sourceCreds,
        destCreds,
        sourceSql,
        destSql,
        sourceIntrospection: new IntrospectionRepository(sourceSql),
        destIntrospection: new IntrospectionRepository(destSql),
        sourceData: new DataRepository(sourceSql),
        destData: new DataRepository(destSql),
        sourceStorage: new StorageRepository(sourceCreds, sourceSql),
        destStorage: new StorageRepository(destCreds, destSql),
        sourceAuth: new AuthRepository(sourceCreds, sourceSql),
        destAuth: new AuthRepository(destCreds, destSql),
        sourceEdge: new EdgeFunctionRepository(sourceCreds),
        destEdge: new EdgeFunctionRepository(destCreds),
        limiter: new BandwidthLimiter(job.options.bandwidthLimitBytesPerSec),
        meter: new ThroughputMeter(),
        signal: this.signal,
        sourceSchema: { schemas: [], extensions: [], types: [], sequences: [], tables: [], views: [], routines: [], triggers: [], policies: [], grants: [], publications: [] },
        destTables: new Map(),
      };

      // Re-introspect on every run rather than trusting the discovery snapshot: the
      // source may have changed since the job was created, especially on a resume
      // hours later.
      logger.info('system', 'Reading source schema');
      const schemas = migratableSchemas(
        { ...context.sourceSchema, schemas: await context.sourceIntrospection.schemas() },
        job.options.includeSchemas,
        job.options.excludeSchemas,
      );
      context.sourceSchema = await context.sourceIntrospection.introspect(schemas);
      logger.success('system', `Source schema read: ${context.sourceSchema.tables.length} tables across ${schemas.length} schemas`);

      // Build (or rebuild) the task list. Existing task state is preserved so a
      // resume knows what is already done.
      job.tasks = this.buildTasks(job, context.sourceSchema);
      await this.persist(job);
      eventBus.publish(this.jobId, { type: 'snapshot', job });

      // A heartbeat pushing throughput/ETA to the UI, independent of task progress.
      const heartbeat = this.startHeartbeat(context, runStartedAt);

      try {
        await this.runStages(context);
      } finally {
        clearInterval(heartbeat);
      }

      // Validation runs even after errors — especially after errors, since that is
      // when the user most needs to know what is missing.
      this.signal();
      logger.info('system', 'Validating migration');
      job.validation = await validate(context).catch((err: unknown) => {
        logger.warn('system', `Validation could not complete: ${toMigrationError(err).message}`);
        return null;
      });

      const failedTasks = job.tasks.filter((t) => t.status === 'failed');
      job.status = failedTasks.length > 0 ? 'completed_with_errors' : 'completed';
      job.finishedAt = new Date().toISOString();
      job.elapsedMs += Date.now() - runStartedAt;

      logger.success(
        'system',
        failedTasks.length > 0
          ? `Migration finished with ${failedTasks.length} failed task(s)`
          : 'Migration completed successfully',
        { rows: job.stats.rowsMigrated, files: job.stats.filesMigrated, bytes: job.stats.bytesTransferred },
      );

      await this.persist(job);
      eventBus.publish(this.jobId, { type: 'status', status: job.status, error: null });
      eventBus.publish(this.jobId, { type: 'snapshot', job });

      // Terminal state reached: wipe the credentials rather than letting them idle
      // in memory until the TTL expires.
      credentialVault.clear(this.jobId);
    } catch (err) {
      job.elapsedMs += Date.now() - runStartedAt;

      if (err instanceof PausedError) {
        job.status = 'paused';
        logger.warn('system', 'Migration paused — progress is checkpointed and can be resumed');
        await this.persist(job);
        eventBus.publish(this.jobId, { type: 'status', status: 'paused', error: null });
      } else if (err instanceof CancelledError) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        logger.warn('system', 'Migration cancelled');
        await this.persist(job);
        eventBus.publish(this.jobId, { type: 'status', status: 'cancelled', error: null });
        credentialVault.clear(this.jobId);
      } else {
        const error = toMigrationError(err);
        job.status = 'failed';
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        logger.error('system', `Migration failed: ${error.message}`, { detail: error.detail });
        await this.persist(job);
        eventBus.publish(this.jobId, { type: 'status', status: 'failed', error: error.message });
      }

      eventBus.publish(this.jobId, { type: 'snapshot', job });
    } finally {
      await sourceSql?.dispose();
      await destSql?.dispose();
      runners.delete(this.jobId);
    }
  }

  /** Pushes throughput and ETA to the UI once a second. */
  private startHeartbeat(context: RunContext, runStartedAt: number): NodeJS.Timeout {
    const timer = setInterval(() => {
      const { bytesPerSec, rowsPerSec } = context.meter.rates();

      const remainingRows = context.job.tasks
        .filter((t) => t.stage === 'data' || t.stage === 'auth_users')
        .reduce((sum, t) => sum + Math.max(0, (t.total ?? 0) - t.processed), 0);

      const remainingBytes = context.job.tasks
        .filter((t) => t.stage === 'storage_files')
        .reduce((sum, t) => sum + Math.max(0, (t.total ?? 0) - t.processed), 0);

      eventBus.publish(this.jobId, {
        type: 'throughput',
        bytesPerSec,
        rowsPerSec,
        etaMs: context.meter.eta(remainingRows, remainingBytes),
      });
      eventBus.publish(this.jobId, {
        type: 'stats',
        stats: context.job.stats,
        elapsedMs: context.job.elapsedMs + (Date.now() - runStartedAt),
      });

      // Slide the vault TTL forward so a long migration does not expire mid-run.
      credentialVault.touch(this.jobId);
    }, 1000);

    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  private async persist(job: MigrationJob): Promise<void> {
    await jobRepository.save(job);
  }

  // -------------------------------------------------------------------------
  // Task planning
  // -------------------------------------------------------------------------

  /**
   * Builds the task list, preserving the state of any task that already exists.
   *
   * Task ids are **deterministic** (`data:public.orders`, not a random uuid), which
   * is what lets a resume match a freshly-planned task to its saved progress. A
   * random id would mean every resume starts from zero.
   */
  private buildTasks(job: MigrationJob, schema: DatabaseSchema): MigrationTask[] {
    const existing = new Map(job.tasks.map((t) => [t.id, t]));
    const tasks: MigrationTask[] = [];

    const add = (id: string, stage: StageId, label: string, total: number | null): void => {
      const prior = existing.get(id);
      tasks.push(
        prior ?? {
          id,
          stage,
          label,
          status: 'pending',
          total,
          processed: 0,
          bytes: 0,
          attempts: 0,
          cursor: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        },
      );
      // Totals may have changed since the last run (rows added at the source).
      if (prior && total !== null) prior.total = Math.max(prior.total ?? 0, total);
    };

    const phases = buildPhases(schema);

    // Pre-data DDL.
    for (const phase of PRE_DATA_PHASES) {
      const statements = phases.get(phase) ?? [];
      if (statements.length === 0) continue;
      if (!job.selection[phaseStage(phase)]) continue;
      add(`ddl:${phase}`, phaseStage(phase), `${phaseLabel(phase)} (${statements.length})`, statements.length);
    }

    // Data — one task per user table, so each is independently resumable.
    if (job.selection.data) {
      for (const table of schema.tables) {
        if (isManagedSchemaName(table.schema)) continue;
        if (table.kind === 'foreign') continue;
        add(`data:${table.schema}.${table.name}`, 'data', `${table.schema}.${table.name}`, table.estimatedRows);
      }
    }

    // Post-data DDL.
    for (const phase of POST_DATA_PHASES) {
      const statements = phases.get(phase) ?? [];
      if (statements.length === 0) continue;
      if (!job.selection[phaseStage(phase)]) continue;
      add(`ddl:${phase}`, phaseStage(phase), `${phaseLabel(phase)} (${statements.length})`, statements.length);
    }

    // Storage.
    if (job.selection.buckets) add('buckets', 'buckets', 'Storage buckets', null);
    if (job.selection.storage_files) {
      for (const bucket of job.discovery?.buckets ?? []) {
        add(`files:${bucket.id}`, 'storage_files', bucket.name, bucket.bytes > 0 ? bucket.bytes : null);
      }
    }

    // Auth — one task per auth table.
    if (job.selection.auth_users) {
      for (const entry of MANAGED_DATA_TABLES.filter((t) => t.stage === 'auth')) {
        add(`auth:${entry.table}`, 'auth_users', `auth.${entry.table}`, null);
      }
    }

    // Edge functions.
    if (job.selection.edge_functions) {
      for (const fn of job.discovery?.edgeFunctions ?? []) {
        add(`edge:${fn.slug}`, 'edge_functions', fn.slug, 1);
      }
    }

    if (job.selection.realtime) add('realtime', 'realtime', 'Realtime publication', null);

    return tasks;
  }

  // -------------------------------------------------------------------------
  // Stage execution
  // -------------------------------------------------------------------------

  private async runStages(context: RunContext): Promise<void> {
    const { job } = context;
    const phases = buildPhases(context.sourceSchema);

    for (const phase of PRE_DATA_PHASES) {
      await this.runDdlPhase(context, phase, phases.get(phase) ?? []);
    }

    if (job.selection.data) await this.runDataStage(context);

    for (const phase of POST_DATA_PHASES) {
      await this.runDdlPhase(context, phase, phases.get(phase) ?? []);
    }

    if (job.selection.buckets || job.selection.storage_files) await this.runStorageStage(context);
    if (job.selection.auth_users) await this.runAuthStage(context);
    if (job.selection.edge_functions) await this.runEdgeStage(context);
    if (job.selection.realtime) await this.runRealtimeStage(context);
  }

  /**
   * Applies one DDL phase, statement by statement.
   *
   * Statements run individually rather than as one batch on purpose: a single failing
   * `CREATE TRIGGER` in a batch would roll back the other 400 that were fine. Applying
   * them one at a time means one bad object costs exactly one object.
   *
   * The `cursor` is the index of the last statement applied, so a phase interrupted
   * at statement 700 of 900 resumes at 701.
   */
  private async runDdlPhase(context: RunContext, phase: DdlPhase, statements: readonly DdlStatement[]): Promise<void> {
    const { job, logger, destSql } = context;
    const task = job.tasks.find((t) => t.id === `ddl:${phase}`);
    if (!task || statements.length === 0) return;
    if (task.status === 'completed') return;

    await this.beginTask(context, task);
    const startIndex = task.cursor !== null ? Number.parseInt(task.cursor, 10) + 1 : 0;

    if (startIndex > 0) {
      logger.info(task.stage, `Resuming ${phaseLabel(phase)} at statement ${startIndex + 1}/${statements.length}`);
    }

    let failures = 0;

    for (let i = startIndex; i < statements.length; i += 1) {
      this.signal();
      const statement = statements[i]!;

      try {
        await withRetry(() => destSql.execute(statement.sql), {
          maxAttempts: job.options.maxRetries,
          baseDelayMs: DEFAULTS.retryBaseDelayMs,
          maxDelayMs: DEFAULTS.retryMaxDelayMs,
          signal: this.signal,
          onRetry: (attempt, error, delayMs) => {
            job.stats.retries += 1;
            logger.warn(task.stage, `Retry ${attempt} for ${statement.object}: ${error.message}`, {
              detail: `waiting ${delayMs}ms`,
            });
          },
        });
        job.stats.objectsCreated += 1;
      } catch (err) {
        if (err instanceof PausedError || err instanceof CancelledError) throw err;

        const error = toMigrationError(err);
        failures += 1;
        job.stats.errors += 1;
        logger.error(task.stage, `${statement.object}: ${error.message}`, {
          detail: truncate(statement.sql, 400),
        });

        if (!job.options.continueOnError) throw error;
      }

      task.processed = i + 1;
      task.cursor = String(i);

      // Checkpoint periodically, not on every statement — an fsync per statement
      // would dominate the runtime of a 5,000-statement phase.
      if (i % 25 === 0 || i === statements.length - 1) {
        await this.checkpoint(context, task);
      }
    }

    await this.completeTask(context, task, failures);
    logger.success(task.stage, `${phaseLabel(phase)}: ${statements.length - failures}/${statements.length} applied`, {
      durationMs: task.startedAt !== null ? Date.now() - Date.parse(task.startedAt) : undefined,
    });
  }

  /**
   * Copies every user table's rows.
   *
   * Tables run through a concurrency pool. Safe to parallelise precisely because
   * foreign keys and triggers do not exist yet at this point (see `POST_DATA_PHASES`)
   * — there is no ordering constraint between tables to violate.
   */
  private async runDataStage(context: RunContext): Promise<void> {
    const { job, logger } = context;
    const tasks = job.tasks.filter((t) => t.stage === 'data' && t.status !== 'completed');
    if (tasks.length === 0) return;

    logger.info('data', `Copying ${tasks.length} table(s) with ${job.options.tableConcurrency} workers`);

    // Read destination table shapes once, for column intersection.
    const destSchemas = migratableSchemas(
      { ...context.sourceSchema, schemas: await context.destIntrospection.schemas() },
      job.options.includeSchemas,
      job.options.excludeSchemas,
    );
    for (const table of await context.destIntrospection.tables(destSchemas)) {
      context.destTables.set(`${table.schema}.${table.name}`, table);
    }

    await runPool(
      tasks,
      job.options.tableConcurrency,
      async (task) => {
        await this.copyTable(context, task);
      },
      (task, error) => {
        task.status = 'failed';
        task.error = error.message;
        job.stats.errors += 1;
        logger.error('data', `${task.label}: ${error.message}`, { detail: error.detail });
        void this.checkpoint(context, task);
        return job.options.continueOnError;
      },
    );
  }

  private async copyTable(context: RunContext, task: MigrationTask): Promise<void> {
    const { job, logger, sourceData, destData } = context;
    const key = task.id.slice('data:'.length);
    const source = context.sourceSchema.tables.find((t) => `${t.schema}.${t.name}` === key);
    if (!source) return;

    const destination = context.destTables.get(key);
    const plan = DataRepository.plan(source, destination);

    if (plan === null) {
      task.status = 'skipped';
      job.stats.skipped += 1;
      logger.warn('data', `${key}: skipped — the destination has no matching table or no columns in common`);
      await this.checkpoint(context, task);
      return;
    }

    await this.beginTask(context, task);

    // A truncate must only happen on a fresh start, never on a resume — truncating
    // on resume would throw away the 900,000 rows we already copied.
    if (job.options.truncateBeforeCopy && task.cursor === null) {
      await destData.truncate(plan.schema, plan.table);
      logger.info('data', `${key}: truncated destination before copy`);
    }

    // The exact count is worth one query per table: it makes the progress bar and
    // the ETA truthful, where reltuples is only an estimate.
    const exact = await sourceData.count(plan.schema, plan.table).catch(() => source.estimatedRows);
    task.total = exact;

    if (task.cursor !== null) {
      logger.info('data', `${key}: resuming from checkpoint (${task.processed.toLocaleString()} rows already copied)`);
    }

    const started = Date.now();

    for await (const batch of sourceData.readBatches(plan, job.options.batchSize, task.cursor, this.signal)) {
      this.signal();

      await withRetry(() => destData.insertBatch(plan, batch.json, job.options.onConflict), {
        maxAttempts: job.options.maxRetries,
        baseDelayMs: DEFAULTS.retryBaseDelayMs,
        maxDelayMs: DEFAULTS.retryMaxDelayMs,
        signal: this.signal,
        onRetry: (attempt, error, delayMs) => {
          job.stats.retries += 1;
          task.attempts += 1;
          logger.warn('data', `${key}: retry ${attempt} — ${error.message}`, { detail: `waiting ${delayMs}ms` });
        },
      });

      const bytes = Buffer.byteLength(batch.json, 'utf8');
      task.processed += batch.rowCount;
      task.bytes += bytes;
      task.cursor = batch.nextCursor;
      job.stats.rowsMigrated += batch.rowCount;
      job.stats.bytesTransferred += bytes;
      context.meter.record(bytes, batch.rowCount);

      // Checkpoint every batch. This is the promise of resumability, and the cost —
      // one small atomic file write per 1000 rows — is trivial next to the round-trip
      // that produced them.
      await this.checkpoint(context, task);
    }

    await this.completeTask(context, task, 0);
    logger.success('data', `${key}: ${task.processed.toLocaleString()} rows copied`, {
      durationMs: Date.now() - started,
      rows: task.processed,
      bytes: task.bytes,
    });
  }

  /** Creates buckets, then transfers their objects. */
  private async runStorageStage(context: RunContext): Promise<void> {
    const { job, logger, sourceStorage, destStorage } = context;

    const buckets = await sourceStorage.listBuckets();

    // Buckets.
    const bucketTask = job.tasks.find((t) => t.id === 'buckets');
    if (bucketTask && bucketTask.status !== 'completed' && job.selection.buckets) {
      await this.beginTask(context, bucketTask);
      bucketTask.total = buckets.length;

      for (const bucket of buckets) {
        this.signal();
        try {
          const outcome = await withRetry(() => destStorage.createBucket(bucket), {
            maxAttempts: job.options.maxRetries,
            baseDelayMs: DEFAULTS.retryBaseDelayMs,
            maxDelayMs: DEFAULTS.retryMaxDelayMs,
            signal: this.signal,
            onRetry: () => {
              job.stats.retries += 1;
            },
          });
          bucketTask.processed += 1;
          job.stats.objectsCreated += 1;
          logger.success('buckets', `Bucket ${bucket.name} (${bucket.public ? 'public' : 'private'}): ${outcome}`);
        } catch (err) {
          if (err instanceof PausedError || err instanceof CancelledError) throw err;
          const error = toMigrationError(err);
          job.stats.errors += 1;
          logger.error('buckets', `Bucket ${bucket.name}: ${error.message}`);
          if (!job.options.continueOnError) throw error;
        }
        await this.checkpoint(context, bucketTask);
      }

      await this.completeTask(context, bucketTask, 0);
    }

    if (!job.selection.storage_files) return;

    // Files, one task per bucket, buckets in parallel and objects within a bucket in
    // parallel too.
    const fileTasks = job.tasks.filter((t) => t.stage === 'storage_files' && t.status !== 'completed');
    if (fileTasks.length === 0) return;

    for (const task of fileTasks) {
      this.signal();
      const bucketId = task.id.slice('files:'.length);
      const bucket = buckets.find((b) => b.id === bucketId);
      if (!bucket) {
        task.status = 'skipped';
        job.stats.skipped += 1;
        await this.checkpoint(context, task);
        continue;
      }

      try {
        await this.copyBucketObjects(context, task, bucketId);
      } catch (err) {
        if (err instanceof PausedError || err instanceof CancelledError) throw err;
        const error = toMigrationError(err);
        task.status = 'failed';
        task.error = error.message;
        job.stats.errors += 1;
        logger.error('storage_files', `Bucket ${bucketId}: ${error.message}`);
        await this.checkpoint(context, task);
        if (!job.options.continueOnError) throw error;
      }
    }
  }

  private async copyBucketObjects(context: RunContext, task: MigrationTask, bucketId: string): Promise<void> {
    const { job, logger, sourceStorage } = context;
    await this.beginTask(context, task);

    const stats = await sourceStorage.bucketStats(bucketId).catch(() => ({ count: 0, bytes: 0 }));
    task.total = stats.bytes > 0 ? stats.bytes : null;

    if (task.cursor !== null) {
      logger.info('storage_files', `${bucketId}: resuming after ${task.cursor}`);
    }

    const started = Date.now();
    let copied = 0;

    // Objects are yielded page by page and each page is drained by the pool before
    // the next is fetched. Memory stays bounded no matter how many objects a bucket
    // holds — a million-object bucket uses the same memory as a ten-object one.
    for await (const page of sourceStorage.listObjects(bucketId, 200, task.cursor)) {
      this.signal();

      await runPool(
        page.objects,
        job.options.storageConcurrency,
        async (object) => {
          await this.copyObject(context, task, object);
          copied += 1;
        },
        (object, error) => {
          job.stats.errors += 1;
          logger.error('storage_files', `${bucketId}/${object.name}: ${error.message}`);
          return job.options.continueOnError;
        },
      );

      // The page is done, so every object up to its last name is safely transferred.
      // Checkpointing per page rather than per object keeps the cursor monotonic even
      // though the objects within a page complete out of order.
      const last = page.objects[page.objects.length - 1];
      if (last) {
        task.cursor = last.name;
        await this.checkpoint(context, task);
      }
      if (page.nextCursor === null) break;
    }

    await this.completeTask(context, task, 0);
    logger.success('storage_files', `${bucketId}: ${copied.toLocaleString()} file(s) transferred`, {
      durationMs: Date.now() - started,
      files: copied,
      bytes: task.bytes,
    });
  }

  /** Streams one object across, choosing single-shot or resumable multipart by size. */
  private async copyObject(
    context: RunContext,
    task: MigrationTask,
    object: Parameters<StorageRepository['download']>[0],
  ): Promise<void> {
    const { job, sourceStorage, destStorage, limiter } = context;

    await withRetry(
      async () => {
        this.signal();

        // On a resume, an object already at the destination is skipped rather than
        // re-transferred. On a multi-GB bucket this is the difference between minutes
        // and hours.
        if (!job.options.overwriteStorage && (await destStorage.exists(object.bucketId, object.name))) {
          job.stats.skipped += 1;
          return;
        }

        const { stream, contentType, size } = await sourceStorage.download(object);

        if (size >= job.options.multipartThresholdBytes) {
          await destStorage.uploadResumable(
            object,
            stream,
            contentType,
            size,
            DEFAULTS.multipartChunkBytes,
            job.options.overwriteStorage,
            limiter,
            (bytes) => {
              task.bytes += bytes;
              job.stats.bytesTransferred += bytes;
              context.meter.record(bytes, 0);
            },
            this.signal,
          );
        } else {
          await limiter.consume(size, this.signal);
          await destStorage.upload(object, stream, contentType, job.options.overwriteStorage);
          task.bytes += size;
          job.stats.bytesTransferred += size;
          context.meter.record(size, 0);
        }

        task.processed += size;
        job.stats.filesMigrated += 1;
      },
      {
        maxAttempts: job.options.maxRetries,
        baseDelayMs: DEFAULTS.retryBaseDelayMs,
        maxDelayMs: DEFAULTS.retryMaxDelayMs,
        signal: this.signal,
        onRetry: (attempt, error, delayMs) => {
          job.stats.retries += 1;
          context.logger.warn('storage_files', `${object.name}: retry ${attempt} — ${error.message}`, {
            detail: `waiting ${delayMs}ms`,
          });
        },
      },
    );
  }

  /**
   * Migrates `auth.*`.
   *
   * Prefers a straight SQL copy, which preserves ids, password hashes, identities,
   * MFA factors and sessions. Falls back to the Admin API only when the destination
   * has no SQL transport, and warns clearly about what that costs.
   */
  private async runAuthStage(context: RunContext): Promise<void> {
    const { job, logger, sourceAuth, destAuth } = context;

    if (!sourceAuth.canUseSql || !destAuth.canUseSql) {
      await this.runAuthViaApi(context);
      return;
    }

    const sourceTables = await sourceAuth.existingAuthTables();
    const destTables = new Set(await destAuth.existingAuthTables());

    for (const table of sourceTables) {
      this.signal();
      const task = job.tasks.find((t) => t.id === `auth:${table}`);
      if (!task || task.status === 'completed') continue;

      if (!destTables.has(table)) {
        task.status = 'skipped';
        job.stats.skipped += 1;
        logger.warn('auth_users', `auth.${table}: the destination has no such table (different GoTrue version) — skipped`);
        await this.checkpoint(context, task);
        continue;
      }

      try {
        await this.copyAuthTable(context, task, table);
      } catch (err) {
        if (err instanceof PausedError || err instanceof CancelledError) throw err;
        const error = toMigrationError(err);
        task.status = 'failed';
        task.error = error.message;
        job.stats.errors += 1;
        logger.error('auth_users', `auth.${table}: ${error.message}`);
        await this.checkpoint(context, task);
        if (!job.options.continueOnError) throw error;
      }
    }
  }

  private async copyAuthTable(context: RunContext, task: MigrationTask, table: string): Promise<void> {
    const { job, logger, sourceAuth, destAuth, sourceData, destData } = context;

    const source = await sourceAuth.describeTable(table);
    const destination = await destAuth.describeTable(table);
    const plan = DataRepository.plan(source!, destination ?? undefined);

    if (source === null || plan === null) {
      task.status = 'skipped';
      job.stats.skipped += 1;
      await this.checkpoint(context, task);
      return;
    }

    await this.beginTask(context, task);

    const total = await sourceData.count('auth', table).catch(() => 0);
    task.total = total;
    if (total === 0) {
      await this.completeTask(context, task, 0);
      return;
    }

    const started = Date.now();

    for await (const batch of sourceData.readBatches(plan, job.options.batchSize, task.cursor, this.signal)) {
      this.signal();

      await withRetry(
        // Always `skip` on conflict for auth: a user that already exists at the
        // destination must not have their password hash overwritten by a re-run.
        () => destData.insertBatch(plan, batch.json, 'skip'),
        {
          maxAttempts: job.options.maxRetries,
          baseDelayMs: DEFAULTS.retryBaseDelayMs,
          maxDelayMs: DEFAULTS.retryMaxDelayMs,
          signal: this.signal,
          onRetry: (attempt, error) => {
            job.stats.retries += 1;
            logger.warn('auth_users', `auth.${table}: retry ${attempt} — ${error.message}`);
          },
        },
      );

      task.processed += batch.rowCount;
      task.cursor = batch.nextCursor;
      job.stats.rowsMigrated += batch.rowCount;
      if (table === 'users') job.stats.usersMigrated += batch.rowCount;
      context.meter.record(Buffer.byteLength(batch.json, 'utf8'), batch.rowCount);

      await this.checkpoint(context, task);
    }

    await this.completeTask(context, task, 0);
    logger.success('auth_users', `auth.${table}: ${task.processed.toLocaleString()} row(s)`, {
      durationMs: Date.now() - started,
      rows: task.processed,
    });
  }

  /** Admin API fallback. Users only — identities, MFA and sessions cannot come this way. */
  private async runAuthViaApi(context: RunContext): Promise<void> {
    const { job, logger, sourceAuth, destAuth } = context;
    const task = job.tasks.find((t) => t.id === 'auth:users');
    if (!task || task.status === 'completed') return;

    logger.warn(
      'auth_users',
      'No SQL transport on one end, so auth is migrating over the Admin API. Password hashes and user ids are preserved, but identities (OAuth logins), MFA factors and active sessions cannot be — affected users will need to re-link social logins and re-enrol 2FA.',
    );

    await this.beginTask(context, task);
    task.total = await sourceAuth.countUsers();
    const started = Date.now();

    for await (const users of sourceAuth.listUsersViaApi()) {
      this.signal();

      await runPool(
        users,
        Math.min(4, job.options.tableConcurrency),
        async (user) => {
          await withRetry(() => destAuth.createUserViaApi(user), {
            maxAttempts: job.options.maxRetries,
            baseDelayMs: DEFAULTS.retryBaseDelayMs,
            maxDelayMs: DEFAULTS.retryMaxDelayMs,
            signal: this.signal,
            onRetry: () => {
              job.stats.retries += 1;
            },
          });
          task.processed += 1;
          job.stats.usersMigrated += 1;
        },
        (user, error) => {
          job.stats.errors += 1;
          logger.error('auth_users', `User ${String(user.email ?? user.id)}: ${error.message}`);
          return job.options.continueOnError;
        },
      );

      await this.checkpoint(context, task);
    }

    // Mark the other auth tables as skipped, so the UI does not show them pending forever.
    for (const other of job.tasks.filter((t) => t.stage === 'auth_users' && t.id !== 'auth:users')) {
      if (other.status === 'pending') {
        other.status = 'skipped';
        job.stats.skipped += 1;
      }
    }

    await this.completeTask(context, task, 0);
    logger.success('auth_users', `${task.processed.toLocaleString()} user(s) migrated via the Admin API`, {
      durationMs: Date.now() - started,
    });
  }

  private async runEdgeStage(context: RunContext): Promise<void> {
    const { job, logger, sourceEdge, destEdge } = context;

    if (!sourceEdge.available) {
      logger.warn('edge_functions', sourceEdge.unavailableReason ?? 'Edge Functions cannot be read from the source');
      this.skipStage(context, 'edge_functions');
      return;
    }
    if (!destEdge.available) {
      logger.warn(
        'edge_functions',
        `${destEdge.unavailableReason ?? 'The destination cannot receive Edge Functions'} Their source has been read and is available in the migration report, so you can commit it to supabase/functions/ and run "supabase functions deploy".`,
      );
      this.skipStage(context, 'edge_functions');
      return;
    }

    const functions = await sourceEdge.list();

    for (const fn of functions) {
      this.signal();
      const task = job.tasks.find((t) => t.id === `edge:${fn.slug}`);
      if (!task || task.status === 'completed') continue;

      await this.beginTask(context, task);

      try {
        const files = await sourceEdge.fetchBody(fn.slug);
        if (files === null) {
          task.status = 'skipped';
          job.stats.skipped += 1;
          logger.warn('edge_functions', `${fn.slug}: source could not be read, so it was not deployed`);
          await this.checkpoint(context, task);
          continue;
        }

        await withRetry(() => destEdge.deploy(fn, files), {
          maxAttempts: job.options.maxRetries,
          baseDelayMs: DEFAULTS.retryBaseDelayMs,
          maxDelayMs: DEFAULTS.retryMaxDelayMs,
          signal: this.signal,
          onRetry: () => {
            job.stats.retries += 1;
          },
        });

        task.processed = 1;
        job.stats.objectsCreated += 1;
        await this.completeTask(context, task, 0);
        logger.success('edge_functions', `${fn.slug}: deployed`);
      } catch (err) {
        if (err instanceof PausedError || err instanceof CancelledError) throw err;
        const error = toMigrationError(err);
        task.status = 'failed';
        task.error = error.message;
        job.stats.errors += 1;
        logger.error('edge_functions', `${fn.slug}: ${error.message}`);
        await this.checkpoint(context, task);
        if (!job.options.continueOnError) throw error;
      }
    }
  }

  /** Re-creates the Realtime publication so the destination broadcasts the same tables. */
  private async runRealtimeStage(context: RunContext): Promise<void> {
    const { job, logger, destSql, sourceSchema } = context;
    const task = job.tasks.find((t) => t.id === 'realtime');
    if (!task || task.status === 'completed') return;

    const publication = sourceSchema.publications.find((p) => p.name === REALTIME_PUBLICATION);
    if (!publication) {
      task.status = 'skipped';
      job.stats.skipped += 1;
      logger.info('realtime', 'The source has no supabase_realtime publication — nothing to enable');
      await this.checkpoint(context, task);
      return;
    }

    await this.beginTask(context, task);
    task.total = publication.allTables ? 1 : publication.tables.length;

    try {
      const operations = [
        publication.insert ? 'insert' : null,
        publication.update ? 'update' : null,
        publication.delete ? 'delete' : null,
        publication.truncate ? 'truncate' : null,
      ].filter((op): op is string => op !== null);

      const withClause = operations.length > 0 ? ` with (publish = '${operations.join(', ')}')` : '';

      // Drop and recreate: `ALTER PUBLICATION ... ADD TABLE` fails if the table is
      // already a member, and there is no `ADD TABLE IF NOT EXISTS`. Recreating is
      // the only idempotent form, and it is cheap.
      await destSql.execute(`drop publication if exists ${REALTIME_PUBLICATION}`);

      if (publication.allTables) {
        await destSql.execute(`create publication ${REALTIME_PUBLICATION} for all tables${withClause}`);
        task.processed = 1;
        logger.success('realtime', 'Realtime enabled for all tables');
      } else if (publication.tables.length === 0) {
        await destSql.execute(`create publication ${REALTIME_PUBLICATION}${withClause}`);
        logger.info('realtime', 'Realtime publication created with no tables (matching the source)');
      } else {
        await destSql.execute(`create publication ${REALTIME_PUBLICATION}${withClause}`);

        for (const entry of publication.tables) {
          this.signal();
          try {
            await destSql.execute(
              `alter publication ${REALTIME_PUBLICATION} add table ${quoteQualified(entry.schema, entry.table)}`,
            );
            task.processed += 1;
          } catch (err) {
            // A table that failed to migrate cannot be published. Log it, keep going.
            job.stats.errors += 1;
            logger.warn(
              'realtime',
              `Could not publish ${entry.schema}.${entry.table}: ${toMigrationError(err).message}`,
            );
          }
        }
        logger.success('realtime', `Realtime enabled for ${task.processed}/${publication.tables.length} table(s)`);
      }

      await this.completeTask(context, task, 0);
    } catch (err) {
      if (err instanceof PausedError || err instanceof CancelledError) throw err;
      const error = toMigrationError(err);
      task.status = 'failed';
      task.error = error.message;
      job.stats.errors += 1;
      logger.error('realtime', error.message);
      await this.checkpoint(context, task);
      if (!job.options.continueOnError) throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Task bookkeeping
  // -------------------------------------------------------------------------

  private async beginTask(context: RunContext, task: MigrationTask): Promise<void> {
    task.status = 'running';
    task.startedAt ??= new Date().toISOString();
    task.error = null;
    await this.checkpoint(context, task);
  }

  private async completeTask(context: RunContext, task: MigrationTask, failures: number): Promise<void> {
    task.status = failures > 0 ? 'failed' : 'completed';
    task.finishedAt = new Date().toISOString();
    if (failures > 0) task.error = `${failures} statement(s) failed`;
    await this.checkpoint(context, task);
  }

  private skipStage(context: RunContext, stage: StageId): void {
    for (const task of context.job.tasks) {
      if (task.stage === stage && task.status === 'pending') {
        task.status = 'skipped';
        context.job.stats.skipped += 1;
        eventBus.publish(this.jobId, { type: 'task', task });
      }
    }
    void this.persist(context.job);
  }

  /** Writes the job to disk and pushes the task to the UI. The heart of resumability. */
  private async checkpoint(context: RunContext, task: MigrationTask): Promise<void> {
    eventBus.publish(this.jobId, { type: 'task', task });
    await this.persist(context.job);
  }
}

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

/**
 * In-process registry of live migrations.
 *
 * A restart empties it, which is correct and intentional: the in-memory credentials
 * are gone too, so a job that was running when the process died comes back as
 * `paused` and asks for its keys before continuing from its last checkpoint.
 */
const runners = new Map<string, MigrationRunner>();

export const migrationRuntime = {
  async start(jobId: string): Promise<void> {
    if (runners.has(jobId)) return;
    const runner = new MigrationRunner(jobId);
    runners.set(jobId, runner);
    void runner.start();
  },

  pause(jobId: string): boolean {
    const runner = runners.get(jobId);
    if (!runner) return false;
    runner.pause();
    return true;
  },

  cancel(jobId: string): boolean {
    const runner = runners.get(jobId);
    if (!runner) return false;
    runner.cancel();
    return true;
  },

  isRunning(jobId: string): boolean {
    return runners.get(jobId)?.isRunning === true;
  },

  runningIds(): readonly string[] {
    return [...runners.keys()];
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phaseLabel(phase: DdlPhase): string {
  const labels: Record<DdlPhase, string> = {
    schemas: 'Schemas',
    extensions: 'Extensions',
    types: 'Types',
    sequences: 'Sequences',
    tables: 'Tables',
    functions: 'Functions',
    foreign_keys: 'Foreign keys',
    indexes: 'Indexes',
    views: 'Views',
    triggers: 'Triggers',
    policies: 'RLS policies',
    grants: 'Grants',
    sequence_values: 'Sequence values',
  };
  return labels[phase];
}

function isManagedSchemaName(schema: string): boolean {
  // Kept local to avoid importing the DDL layer into the orchestrator's hot path.
  const managed = new Set<string>([
    'auth', 'storage', 'realtime', 'supabase_functions', 'supabase_migrations', 'vault',
    'graphql', 'graphql_public', 'pgsodium', 'pgsodium_masks', 'extensions', 'net',
    'cron', 'pgbouncer', '_analytics', '_realtime', '_supavisor',
  ]);
  return managed.has(schema);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Re-exported so the API layer can build a default options object. */
export function defaultOptions(): MigrationJob['options'] {
  return {
    batchSize: DEFAULTS.batchSize,
    tableConcurrency: DEFAULTS.tableConcurrency,
    storageConcurrency: DEFAULTS.storageConcurrency,
    maxRetries: DEFAULTS.maxRetries,
    bandwidthLimitBytesPerSec: DEFAULTS.bandwidthLimitBytesPerSec,
    multipartThresholdBytes: DEFAULTS.multipartThresholdBytes,
    includeSchemas: [],
    excludeSchemas: [],
    truncateBeforeCopy: false,
    onConflict: 'skip',
    overwriteStorage: false,
    continueOnError: true,
  };
}

export type { RunContext };
export { sleep };
