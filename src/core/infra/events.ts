/**
 * @file Per-job event bus + structured logger.
 *
 * The progress page holds an EventSource open against `/api/migrations/:id/events`.
 * The orchestrator publishes here; the SSE route subscribes. Keeping the bus
 * separate from both means the orchestrator has no idea HTTP exists, and the route
 * has no idea migrations exist.
 *
 * A **replay buffer** of recent events is retained per job so a client that
 * connects late — or reconnects after a dropped socket, which browsers do
 * automatically — immediately catches up on the last stretch of activity instead
 * of staring at a blank log until the next event happens to fire.
 */

import type { LogEntry, LogLevel, MigrationEvent, StageId } from '@/core/domain/types';
import { logRepository, newId } from '@/core/infra/store';

type Listener = (event: MigrationEvent) => void;

const REPLAY_LIMIT = 200;

interface Channel {
  readonly listeners: Set<Listener>;
  readonly replay: MigrationEvent[];
}

const channels = new Map<string, Channel>();

function channelFor(jobId: string): Channel {
  let channel = channels.get(jobId);
  if (!channel) {
    channel = { listeners: new Set(), replay: [] };
    channels.set(jobId, channel);
  }
  return channel;
}

export const eventBus = {
  publish(jobId: string, event: MigrationEvent): void {
    const channel = channelFor(jobId);

    // Snapshots supersede everything before them, so the buffer stays small on
    // long jobs: no point replaying 200 stale task updates the snapshot subsumes.
    if (event.type === 'snapshot') {
      channel.replay.length = 0;
    }
    channel.replay.push(event);
    if (channel.replay.length > REPLAY_LIMIT) channel.replay.shift();

    for (const listener of channel.listeners) {
      // One bad listener (e.g. a socket that just died) must not stop the others.
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  },

  /** Subscribes and immediately replays buffered events. Returns an unsubscribe fn. */
  subscribe(jobId: string, listener: Listener): () => void {
    const channel = channelFor(jobId);
    for (const event of channel.replay) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
    channel.listeners.add(listener);

    return () => {
      channel.listeners.delete(listener);
      // Drop the channel once nobody is listening and it holds nothing worth replaying.
      if (channel.listeners.size === 0 && channel.replay.length === 0) channels.delete(jobId);
    };
  },

  listenerCount(jobId: string): number {
    return channels.get(jobId)?.listeners.size ?? 0;
  },

  /** Frees the replay buffer once a job is finished and read. */
  clear(jobId: string): void {
    channels.delete(jobId);
  },
} as const;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LogFields {
  readonly durationMs?: number;
  readonly rows?: number;
  readonly files?: number;
  readonly bytes?: number;
  readonly detail?: string;
}

/**
 * A logger bound to one job.
 *
 * Every entry is both **persisted** (NDJSON, so it survives a restart and can be
 * searched/downloaded later) and **published** (so it appears in the live log pane
 * within milliseconds). The two paths are independent: a disk hiccup must never
 * take down the live stream, hence the swallowed rejection on append.
 */
export class JobLogger {
  constructor(private readonly jobId: string) {}

  private write(level: LogLevel, stage: StageId | 'system', message: string, fields: LogFields = {}): void {
    const entry: LogEntry = {
      id: newId('log_'),
      jobId: this.jobId,
      ts: new Date().toISOString(),
      level,
      stage,
      message,
      ...fields,
    };

    eventBus.publish(this.jobId, { type: 'log', entry });
    void logRepository.append(entry).catch(() => undefined);
  }

  debug(stage: StageId | 'system', message: string, fields?: LogFields): void {
    this.write('debug', stage, message, fields);
  }

  info(stage: StageId | 'system', message: string, fields?: LogFields): void {
    this.write('info', stage, message, fields);
  }

  success(stage: StageId | 'system', message: string, fields?: LogFields): void {
    this.write('success', stage, message, fields);
  }

  warn(stage: StageId | 'system', message: string, fields?: LogFields): void {
    this.write('warn', stage, message, fields);
  }

  error(stage: StageId | 'system', message: string, fields?: LogFields): void {
    this.write('error', stage, message, fields);
  }

  /** Times an operation and logs its duration on both success and failure. */
  async timed<T>(stage: StageId | 'system', message: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.success(stage, message, { durationMs: Date.now() - started });
      return result;
    } catch (err) {
      this.error(stage, `${message} failed`, {
        durationMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
