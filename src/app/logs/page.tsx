/**
 * @file Global Logs — searchable across every migration.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, RefreshCw, ScrollText, Search } from 'lucide-react';
import type { LogEntry, LogLevel } from '@/core/domain/types';
import { api } from '@/lib/api';
import { cn, formatBytes, formatNumber } from '@/lib/utils';
import { Badge, Button, Card, CardContent, EmptyState, Input } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/shell';

const LEVELS: readonly LogLevel[] = ['info', 'success', 'warn', 'error', 'debug'];

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-[var(--fg-subtle)]',
  info: 'text-[var(--info)]',
  success: 'text-[var(--ok)]',
  warn: 'text-[var(--warn)]',
  error: 'text-[var(--danger)]',
};

export default function LogsPage(): React.JSX.Element {
  const [entries, setEntries] = React.useState<readonly LogEntry[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [levels, setLevels] = React.useState<readonly LogLevel[]>(['info', 'success', 'warn', 'error']);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await api.getAllLogs({ search, levels, limit: 500 });
      setEntries(result.entries);
      setTotal(result.total);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [search, levels]);

  // Debounced so typing does not fire a request per keystroke against a log store
  // that may hold hundreds of thousands of lines.
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const toggleLevel = (level: LogLevel): void => {
    setLevels((current) => (current.includes(level) ? current.filter((l) => l !== level) : [...current, level]));
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Logs" description="Every logged action across every migration.">
        <Button variant="outline" onClick={() => void load()} loading={loading}>
          <RefreshCw />
          Refresh
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages, stages, errors…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-colors',
                levels.includes(level)
                  ? 'border-[var(--color-brand-500)]/40 bg-[var(--color-brand-500)]/12 text-[var(--fg)]'
                  : 'border-[var(--line)] text-[var(--fg-subtle)] hover:text-[var(--fg-muted)]',
              )}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {entries === null ? (
            <div className="space-y-1 p-5">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-[var(--line)]" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No log entries"
              description={
                search !== ''
                  ? 'Nothing matches that search.'
                  : 'Logs appear here once a migration runs.'
              }
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-2.5 text-xs text-[var(--fg-subtle)]">
                <span>
                  Showing {formatNumber(entries.length)} of {formatNumber(total)}
                </span>
                {total > entries.length && <span>Narrow the search to see more</span>}
              </div>

              <div className="scrollbar-thin max-h-[calc(100dvh-18rem)] overflow-y-auto p-2 font-mono text-xs">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex gap-2 rounded px-2 py-1.5 leading-relaxed transition-colors hover:bg-[var(--glass-hover)]"
                  >
                    <span className="shrink-0 text-[var(--fg-subtle)]">
                      {new Date(entry.ts).toLocaleString(undefined, { hour12: false })}
                    </span>
                    <span className={cn('w-10 shrink-0 font-semibold uppercase', LEVEL_STYLE[entry.level])}>
                      {entry.level.slice(0, 3)}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="text-[var(--fg-subtle)]">[{entry.stage}]</span> {entry.message}
                      {entry.rows !== undefined && entry.rows > 0 && (
                        <span className="text-[var(--fg-subtle)]"> · {formatNumber(entry.rows)} rows</span>
                      )}
                      {entry.bytes !== undefined && entry.bytes > 0 && (
                        <span className="text-[var(--fg-subtle)]"> · {formatBytes(entry.bytes)}</span>
                      )}
                      {entry.detail !== undefined && (
                        <span className="mt-0.5 block whitespace-pre-wrap break-all pl-2 text-[11px] text-[var(--fg-subtle)]">
                          {entry.detail}
                        </span>
                      )}
                    </span>

                    {/* Every global log line links back to the migration it came from —
                        without it, a page of interleaved entries from several jobs is
                        very hard to act on. */}
                    <Link
                      href={`/migrations/${entry.jobId}`}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="Open migration"
                    >
                      <Badge tone="neutral" className="gap-1 text-[10px]">
                        <ExternalLink className="size-2.5" />
                        open
                      </Badge>
                    </Link>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
