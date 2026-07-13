/**
 * @file The live log pane, with search, level filters and download.
 *
 * Two sources feed it: entries streamed over SSE while a migration runs, and the
 * persisted NDJSON on disk for everything before that. They are merged and
 * deduplicated by id, so opening the page mid-migration shows the full history rather
 * than only what has happened since you arrived.
 */

'use client';

import * as React from 'react';
import { Download, Search, ScrollText, ArrowDownToLine } from 'lucide-react';
import type { LogEntry, LogLevel } from '@/core/domain/types';
import { api } from '@/lib/api';
import { cn, formatBytes, formatNumber, formatTime } from '@/lib/utils';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input } from '@/components/ui/primitives';

const LEVELS: readonly LogLevel[] = ['info', 'success', 'warn', 'error', 'debug'];

const LEVEL_STYLE: Record<LogLevel, { text: string; label: string }> = {
  debug: { text: 'text-[var(--fg-subtle)]', label: 'DBG' },
  info: { text: 'text-[var(--info)]', label: 'INF' },
  success: { text: 'text-[var(--ok)]', label: 'OK ' },
  warn: { text: 'text-[var(--warn)]', label: 'WRN' },
  error: { text: 'text-[var(--danger)]', label: 'ERR' },
};

export function LogViewer({ jobId, live }: { jobId: string; live: readonly LogEntry[] }): React.JSX.Element {
  const [history, setHistory] = React.useState<readonly LogEntry[]>([]);
  const [search, setSearch] = React.useState('');
  const [levels, setLevels] = React.useState<readonly LogLevel[]>(['info', 'success', 'warn', 'error']);
  const [autoScroll, setAutoScroll] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Load what happened before this page was open.
  React.useEffect(() => {
    void api
      .getLogs(jobId, { limit: 1000 })
      .then((result) => setHistory(result.entries))
      .catch(() => setHistory([]));
  }, [jobId]);

  const entries = React.useMemo(() => {
    // The SSE stream and the on-disk history overlap: the server persists and
    // publishes the same entry. Dedupe by id, preferring whichever we saw.
    const byId = new Map<string, LogEntry>();
    for (const entry of history) byId.set(entry.id, entry);
    for (const entry of live) byId.set(entry.id, entry);

    const merged = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    const needle = search.trim().toLowerCase();

    return merged.filter((entry) => {
      if (!levels.includes(entry.level)) return false;
      if (needle === '') return true;
      return `${entry.message} ${entry.detail ?? ''} ${entry.stage}`.toLowerCase().includes(needle);
    });
  }, [history, live, search, levels]);

  // Follow the tail, but only while the user is actually at the bottom — yanking the
  // view back down while someone is scrolled up reading an error is infuriating.
  React.useEffect(() => {
    if (!autoScroll) return;
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, autoScroll]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const toggleLevel = (level: LogLevel): void => {
    setLevels((current) =>
      current.includes(level) ? current.filter((l) => l !== level) : [...current, level],
    );
  };

  return (
    <Card className="flex h-[36rem] flex-col lg:sticky lg:top-6 lg:h-[calc(100dvh-6rem)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ScrollText className="size-4 text-[var(--fg-subtle)]" />
            Live logs
            <Badge tone="neutral" className="text-[10px]">
              {formatNumber(entries.length)}
            </Badge>
          </CardTitle>
          <Button variant="ghost" size="icon" asChild title="Download logs (NDJSON)">
            <a href={`/api/migrations/${jobId}/logs?download=1`}>
              <Download />
            </a>
          </Button>
        </div>

        <div className="relative mt-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs…"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="mt-1 flex flex-wrap gap-1">
          {LEVELS.map((level) => {
            const active = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors',
                  active
                    ? 'border-[var(--color-brand-500)]/40 bg-[var(--color-brand-500)]/12 text-[var(--fg)]'
                    : 'border-[var(--line)] text-[var(--fg-subtle)] hover:text-[var(--fg-muted)]',
                )}
              >
                {level}
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent className="relative min-h-0 flex-1 p-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scrollbar-thin h-full overflow-y-auto px-5 pb-5 font-mono text-xs"
        >
          {entries.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No log entries"
              description={search !== '' ? 'Nothing matches that search.' : 'Entries appear here as the migration runs.'}
            />
          ) : (
            <div className="space-y-0.5">
              {entries.map((entry) => (
                <LogLine key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>

        {/* Only offered when the user has scrolled away from the tail. */}
        {!autoScroll && entries.length > 0 && (
          <Button
            size="sm"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-xl"
            onClick={() => {
              setAutoScroll(true);
              const element = scrollRef.current;
              if (element !== null) element.scrollTop = element.scrollHeight;
            }}
          >
            <ArrowDownToLine />
            Jump to latest
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LogLine({ entry }: { entry: LogEntry }): React.JSX.Element {
  const style = LEVEL_STYLE[entry.level];

  // Only render the metrics that are actually present — a line reading
  // "0 rows · 0 files · 0 B" is noise pretending to be information.
  const metrics: string[] = [];
  if (entry.rows !== undefined && entry.rows > 0) metrics.push(`${formatNumber(entry.rows)} rows`);
  if (entry.files !== undefined && entry.files > 0) metrics.push(`${formatNumber(entry.files)} files`);
  if (entry.bytes !== undefined && entry.bytes > 0) metrics.push(formatBytes(entry.bytes));
  if (entry.durationMs !== undefined) metrics.push(`${formatNumber(entry.durationMs)}ms`);

  return (
    <div className="group flex gap-2 rounded px-1.5 py-1 leading-relaxed transition-colors hover:bg-[var(--glass-hover)]">
      <span className="shrink-0 text-[var(--fg-subtle)]">{formatTime(entry.ts)}</span>
      <span className={cn('shrink-0 font-semibold', style.text)}>{style.label}</span>
      <span className="min-w-0 flex-1 break-words">
        <span className="text-[var(--fg-subtle)]">[{entry.stage}]</span> {entry.message}
        {metrics.length > 0 && (
          <span className="ml-1.5 text-[var(--fg-subtle)]">({metrics.join(' · ')})</span>
        )}
        {entry.detail !== undefined && (
          <span className="mt-0.5 block whitespace-pre-wrap break-all pl-2 text-[11px] text-[var(--fg-subtle)]">
            {entry.detail}
          </span>
        )}
      </span>
    </div>
  );
}
