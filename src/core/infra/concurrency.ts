/**
 * @file Concurrency, retry, and bandwidth primitives.
 *
 * These three are what keep the tool alive at the sizes the spec demands (1000+
 * tables, millions of rows, multi-GB buckets). The shared idea is *bounded work*:
 * never hold more than N things in flight, never buffer a whole table or file in
 * memory, and never hammer a rate-limited API without backing off.
 */

import { MigrationError, CancelledError, PausedError, toMigrationError } from '@/core/domain/errors';

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

/**
 * Runs an async iterable of jobs with a fixed worker count.
 *
 * Deliberately *pull-based*: workers pull the next item from the iterator only
 * when they finish one, so a 5-million-item source is never materialised as an
 * array of 5 million promises. `Promise.all(items.map(...))` would allocate all of
 * them up front and fall over long before that.
 *
 * @param items  Source of work. May be a lazy generator.
 * @param limit  Maximum in-flight jobs.
 * @param worker Handles one item. Rejections propagate via `onError`.
 * @param onError Called per failed item. Return `true` to keep going, `false` to abort the pool.
 */
export async function runPool<T>(
  items: AsyncIterable<T> | Iterable<T>,
  limit: number,
  worker: (item: T) => Promise<void>,
  onError?: (item: T, error: MigrationError) => boolean | Promise<boolean>,
): Promise<void> {
  const iterator = Symbol.asyncIterator in Object(items)
    ? (items as AsyncIterable<T>)[Symbol.asyncIterator]()
    : asAsyncIterator((items as Iterable<T>)[Symbol.iterator]());

  let aborted: unknown = null;
  const workers: Promise<void>[] = [];
  const workerCount = Math.max(1, Math.floor(limit));

  const drain = async (): Promise<void> => {
    for (;;) {
      if (aborted !== null) return;
      const next = await iterator.next();
      if (next.done === true) return;

      try {
        await worker(next.value);
      } catch (err) {
        // Pause and cancel are control flow, not failures — unwind immediately.
        if (err instanceof CancelledError || err instanceof PausedError) {
          aborted = err;
          return;
        }
        const migrationError = toMigrationError(err);
        const shouldContinue = onError ? await onError(next.value, migrationError) : false;
        if (!shouldContinue) {
          aborted = migrationError;
          return;
        }
      }
    }
  };

  for (let i = 0; i < workerCount; i += 1) workers.push(drain());
  await Promise.all(workers);

  if (aborted !== null) throw aborted;
}

async function* asAsyncIterator<T>(it: Iterator<T>): AsyncIterableIterator<T> {
  for (;;) {
    const next = it.next();
    if (next.done === true) return;
    yield next.value;
  }
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Invoked before each re-attempt; used to bump the job's retry counter and log. */
  readonly onRetry?: (attempt: number, error: MigrationError, delayMs: number) => void | Promise<void>;
  /** Checked before every attempt so a paused/cancelled job doesn't sit in a backoff sleep. */
  readonly signal?: () => void;
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random between 0 and the computed ceiling) rather than fixed
 * backoff matters when 6 storage workers all get 429'd at once: fixed backoff
 * would have them retry in lockstep and get 429'd again. Jitter spreads them out.
 *
 * Only errors marked `retryable` are re-attempted — see `errors.ts` for how that
 * is decided. A syntax error in generated DDL fails immediately rather than
 * wasting five attempts.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: MigrationError = new MigrationError('INTERNAL', 'Retry loop never executed');

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    options.signal?.();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CancelledError || err instanceof PausedError) throw err;

      lastError = toMigrationError(err);
      if (!lastError.retryable || attempt === options.maxAttempts) throw lastError;

      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      await options.onRetry?.(attempt, lastError, delay);
      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

/** Interruptible sleep — polls the pause/cancel signal every 100ms. */
export async function sleep(ms: number, signal?: () => void): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    signal?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 100)));
  }
}

// ---------------------------------------------------------------------------
// Bandwidth limiter
// ---------------------------------------------------------------------------

/**
 * Token-bucket rate limiter for storage byte transfer.
 *
 * Refills continuously at `bytesPerSec` and lets callers burst up to one second's
 * worth. A limit of 0 disables it entirely (the common case) with no overhead.
 *
 * The bucket allows a caller to overdraw on a single large chunk rather than
 * deadlocking: if someone asks for 8 MB against a 1 MB/s limit, they take what is
 * there and go negative, and everyone waits for the balance to recover. Without
 * that, any chunk bigger than the bucket capacity would hang forever.
 */
export class BandwidthLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly bytesPerSec: number) {
    this.tokens = bytesPerSec;
    this.lastRefill = Date.now();
  }

  get enabled(): boolean {
    return this.bytesPerSec > 0;
  }

  /** Blocks until `bytes` of budget are available. No-op when unlimited. */
  async consume(bytes: number, signal?: () => void): Promise<void> {
    if (!this.enabled || bytes <= 0) return;

    // A request larger than the bucket's whole capacity (one second's budget) can
    // never be satisfied in full, so demanding that would hang forever. Instead we
    // require a *full* bucket and then let the caller overdraw into a negative
    // balance — which every subsequent call then has to wait off. The average rate
    // still converges on the limit; only the instantaneous burst exceeds it.
    const required = Math.min(bytes, this.bytesPerSec);

    for (;;) {
      signal?.();
      this.refill();

      if (this.tokens >= required) {
        this.tokens -= bytes;
        return;
      }

      // Sleep for exactly as long as the shortfall needs, capped at a second so the
      // pause/cancel signal stays responsive.
      const deficit = required - this.tokens;
      const waitMs = (deficit / this.bytesPerSec) * 1000;
      await sleep(Math.min(1000, Math.max(5, waitMs)), signal);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsedSec * this.bytesPerSec);
  }
}

// ---------------------------------------------------------------------------
// Throughput tracking
// ---------------------------------------------------------------------------

/**
 * Sliding-window throughput meter powering the live "Transfer Speed" and "ETA"
 * readouts.
 *
 * A sliding window rather than a cumulative average because cumulative averages
 * are useless for ETA: an hour into a migration, a sudden stall barely moves the
 * average, and the ETA keeps cheerfully counting down. A 10-second window reacts.
 */
export class ThroughputMeter {
  private readonly samples: { ts: number; bytes: number; rows: number }[] = [];

  constructor(private readonly windowMs = 10_000) {}

  record(bytes: number, rows: number): void {
    const now = Date.now();
    this.samples.push({ ts: now, bytes, rows });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.ts < cutoff) this.samples.shift();
  }

  /** Returns bytes/sec and rows/sec over the window. */
  rates(): { bytesPerSec: number; rowsPerSec: number } {
    if (this.samples.length < 2) return { bytesPerSec: 0, rowsPerSec: 0 };
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const spanSec = Math.max(0.001, (last.ts - first.ts) / 1000);

    let bytes = 0;
    let rows = 0;
    for (const s of this.samples) {
      bytes += s.bytes;
      rows += s.rows;
    }
    return { bytesPerSec: bytes / spanSec, rowsPerSec: rows / spanSec };
  }

  /** Estimates milliseconds remaining. Null when there is no signal to base it on. */
  eta(remainingRows: number, remainingBytes: number): number | null {
    const { bytesPerSec, rowsPerSec } = this.rates();
    const byRows = rowsPerSec > 0 && remainingRows > 0 ? (remainingRows / rowsPerSec) * 1000 : null;
    const byBytes = bytesPerSec > 0 && remainingBytes > 0 ? (remainingBytes / bytesPerSec) * 1000 : null;

    if (byRows === null && byBytes === null) return null;
    // Whichever dimension says "longer" is the binding constraint.
    return Math.max(byRows ?? 0, byBytes ?? 0);
  }
}
