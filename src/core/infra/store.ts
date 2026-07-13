/**
 * @file Durable, crash-safe local persistence for jobs and logs.
 *
 * Deliberately *not* SQLite. The state we persist is small (a job document of a
 * few hundred KB even for 1000 tables, plus an append-only log) and a native
 * module would add a build-time dependency and a Windows/macOS/Linux prebuild
 * matrix for no real benefit. What we do need is crash safety, which we get from:
 *
 * - **Atomic writes**: serialise to a temp file, `fsync`, then `rename`. Rename is
 *   atomic on POSIX and on Windows/NTFS, so a crash mid-write leaves the previous
 *   good document intact rather than a half-written one. Without this, killing
 *   the process during a checkpoint could corrupt the very file resumability
 *   depends on.
 * - **A write queue per job**, so two concurrent checkpoints can't interleave.
 * - **NDJSON append** for logs, which is naturally crash-tolerant: a torn final
 *   line is discarded on read and everything before it survives.
 *
 * Everything is behind the repository interfaces below, so swapping in Postgres
 * or SQLite later touches exactly one file.
 */

import { mkdir, readFile, writeFile, rename, readdir, unlink, appendFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { LogEntry, LogLevel, MigrationJob, StageId } from '@/core/domain/types';
import { DATA_DIR } from '@/core/domain/constants';

// Keep the constant honest: it is the documented name of the directory, and a
// mismatch between it and the candidates built from it below would be a silent bug.
if (DATA_DIR !== '.nebkern') {
  throw new Error(`DATA_DIR constant (${DATA_DIR}) no longer matches the store's directory name`);
}

interface Dirs {
  readonly root: string;
  readonly jobs: string;
  readonly logs: string;
}

let dirsPromise: Promise<Dirs> | null = null;

/**
 * Resolves and creates the data directory, tolerating a read-only deployment root.
 *
 * `process.cwd()/.nebkern` is the right answer everywhere this app is meant to run —
 * a VPS, a Docker container, Railway, Fly.io — where the directory persists across
 * restarts, which is exactly what makes a migration resumable. See the README's
 * Deployment section.
 *
 * On a serverless platform (Vercel functions, AWS Lambda) the deployed bundle is
 * mounted read-only, so `mkdir` there fails. Rather than crash every single request
 * before it reaches any real work, we fall back to the OS temp directory, which every
 * Node runtime — including a serverless one — guarantees is writable.
 *
 * That fallback keeps the app answering requests; it does not make it durable there.
 * `os.tmpdir()` on a serverless platform is ephemeral per invocation and is not shared
 * across concurrent instances, so job history and resumability do not survive on that
 * path. If you are seeing this fallback engage, you are on a platform this app is not
 * designed to run background migrations on — deploy to one of the targets above
 * instead. `NEBKERN_DATA_DIR` is available as an explicit override, for anyone who
 * wants to point this at a mounted persistent volume rather than rely on the guess.
 */
async function resolveDirs(): Promise<Dirs> {
  dirsPromise ??= (async () => {
    const override = process.env.NEBKERN_DATA_DIR;
    const candidates = override !== undefined && override !== '' ? [override] : [join(process.cwd(), '.nebkern')];

    for (const root of candidates) {
      const jobs = join(root, 'jobs');
      const logs = join(root, 'logs');
      try {
        await mkdir(jobs, { recursive: true });
        await mkdir(logs, { recursive: true });
        return { root, jobs, logs };
      } catch {
        // Read-only filesystem — most likely a serverless deployment. Fall through to
        // the guaranteed-writable location below rather than raising here.
      }
    }

    const root = join(tmpdir(), 'nebkern');
    const jobs = join(root, 'jobs');
    const logs = join(root, 'logs');
    await mkdir(jobs, { recursive: true });
    await mkdir(logs, { recursive: true });
    return { root, jobs, logs };
  })();
  return dirsPromise;
}

/**
 * Serialises writes per key.
 *
 * Two checkpoints for the same job can otherwise race: both read, both mutate,
 * the slower write clobbers the faster one and we lose a cursor. Chaining onto
 * the previous promise makes writes strictly ordered per job while leaving
 * different jobs fully parallel.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Write-temp -> fsync -> rename. Survives a crash at any point. */
async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Job repository
// ---------------------------------------------------------------------------

export interface JobRepository {
  save(job: MigrationJob): Promise<void>;
  find(id: string): Promise<MigrationJob | null>;
  list(): Promise<readonly MigrationJob[]>;
  remove(id: string): Promise<void>;
}

export const jobRepository: JobRepository = {
  async save(job: MigrationJob): Promise<void> {
    const { jobs } = await resolveDirs();
    await enqueue(job.id, () => atomicWrite(join(jobs, `${job.id}.json`), JSON.stringify(job, null, 2)));
  },

  async find(id: string): Promise<MigrationJob | null> {
    const { jobs } = await resolveDirs();
    // Guard against path traversal via a crafted id in the route param.
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    try {
      const raw = await readFile(join(jobs, `${id}.json`), 'utf8');
      return JSON.parse(raw) as MigrationJob;
    } catch {
      return null;
    }
  },

  async list(): Promise<readonly MigrationJob[]> {
    const { jobs: jobsDir } = await resolveDirs();
    const files = await readdir(jobsDir).catch(() => [] as string[]);
    const jobs: MigrationJob[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        jobs.push(JSON.parse(await readFile(join(jobsDir, file), 'utf8')) as MigrationJob);
      } catch {
        // A torn file from a hard kill: skip rather than failing the whole listing.
      }
    }

    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async remove(id: string): Promise<void> {
    const { jobs, logs } = await resolveDirs();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    await unlink(join(jobs, `${id}.json`)).catch(() => undefined);
    await unlink(join(logs, `${id}.ndjson`)).catch(() => undefined);
  },
};

// ---------------------------------------------------------------------------
// Log repository
// ---------------------------------------------------------------------------

export interface LogQuery {
  readonly search?: string;
  readonly levels?: readonly LogLevel[];
  readonly stages?: readonly (StageId | 'system')[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface LogRepository {
  append(entry: LogEntry): Promise<void>;
  query(jobId: string, query?: LogQuery): Promise<{ entries: readonly LogEntry[]; total: number }>;
  /** Full NDJSON text, for the "Download Logs" button. */
  raw(jobId: string): Promise<string>;
  /** Log entries across every job, for the global Logs page. */
  queryAll(query?: LogQuery): Promise<{ entries: readonly LogEntry[]; total: number }>;
}

function logPath(logsDir: string, jobId: string): string {
  return join(logsDir, `${jobId}.ndjson`);
}

/** Parses NDJSON, tolerating a torn final line from an unclean shutdown. */
function parseNdjson(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Torn line — discard it and keep everything that parsed.
    }
  }
  return entries;
}

function matches(entry: LogEntry, query: LogQuery): boolean {
  if (query.levels && query.levels.length > 0 && !query.levels.includes(entry.level)) return false;
  if (query.stages && query.stages.length > 0 && !query.stages.includes(entry.stage)) return false;
  if (query.search !== undefined && query.search !== '') {
    const needle = query.search.toLowerCase();
    const haystack = `${entry.message} ${entry.detail ?? ''} ${entry.stage}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export const logRepository: LogRepository = {
  async append(entry: LogEntry): Promise<void> {
    const { logs } = await resolveDirs();
    // Appends of a single line under the pipe-buffer size are effectively atomic,
    // so unlike job docs these don't need the temp+rename dance.
    await appendFile(logPath(logs, entry.jobId), `${JSON.stringify(entry)}\n`, 'utf8');
  },

  async query(jobId: string, query: LogQuery = {}): Promise<{ entries: readonly LogEntry[]; total: number }> {
    const { logs } = await resolveDirs();
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return { entries: [], total: 0 };

    const raw = await readFile(logPath(logs, jobId), 'utf8').catch(() => '');
    const all = parseNdjson(raw).filter((e) => matches(e, query));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 500;

    return { entries: all.slice(offset, offset + limit), total: all.length };
  },

  async raw(jobId: string): Promise<string> {
    const { logs } = await resolveDirs();
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return '';
    return readFile(logPath(logs, jobId), 'utf8').catch(() => '');
  },

  async queryAll(query: LogQuery = {}): Promise<{ entries: readonly LogEntry[]; total: number }> {
    const { logs } = await resolveDirs();
    const files = await readdir(logs).catch(() => [] as string[]);
    const all: LogEntry[] = [];

    for (const file of files) {
      if (!file.endsWith('.ndjson')) continue;
      const raw = await readFile(join(logs, file), 'utf8').catch(() => '');
      all.push(...parseNdjson(raw).filter((e) => matches(e, query)));
    }

    all.sort((a, b) => b.ts.localeCompare(a.ts));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 500;

    return { entries: all.slice(offset, offset + limit), total: all.length };
  },
};

/** Total bytes used by the local job/log store — shown on the Settings page. */
export async function storeFootprint(): Promise<{ jobs: number; logs: number; bytes: number }> {
  const { jobs, logs } = await resolveDirs();
  let bytes = 0;

  const jobFiles = await readdir(jobs).catch(() => [] as string[]);
  const logFiles = await readdir(logs).catch(() => [] as string[]);

  for (const [dir, files] of [
    [jobs, jobFiles],
    [logs, logFiles],
  ] as const) {
    for (const file of files) {
      const info = await stat(join(dir, file)).catch(() => null);
      if (info) bytes += info.size;
    }
  }

  return { jobs: jobFiles.filter((f) => f.endsWith('.json')).length, logs: logFiles.length, bytes };
}

/** Ensures the data dir exists and returns its absolute path. */
export async function dataDirectory(): Promise<string> {
  const { root } = await resolveDirs();
  return root;
}

/** Convenience used across services — a short, URL-safe, sortable id. */
export function newId(prefix = ''): string {
  const stamp = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}${stamp}${rand}`;
}

// Re-export for callers that only need writeFile-style access in tests.
export { writeFile as _writeFile };
