/**
 * @file Migration History.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Database, Download, FileText, Plus, Search, Trash2 } from 'lucide-react';
import type { JobStatus, MigrationJob } from '@/core/domain/types';
import { api, ApiClientError } from '@/lib/api';
import { cn, formatBytes, formatCompact, formatDuration, formatRelative } from '@/lib/utils';
import { Button, Card, CardContent, EmptyState, Input } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/shell';
import { StatusBadge } from '@/components/app/status-badge';

const FILTERS: readonly { readonly id: 'all' | JobStatus; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'completed_with_errors', label: 'With errors' },
  { id: 'failed', label: 'Failed' },
];

export default function HistoryPage(): React.JSX.Element {
  const [jobs, setJobs] = React.useState<readonly MigrationJob[] | null>(null);
  const [filter, setFilter] = React.useState<'all' | JobStatus>('all');
  const [search, setSearch] = React.useState('');

  // Bumping this re-runs the effect below. It is how an action outside the effect
  // (deleting a migration) asks for a re-fetch, without hoisting a `setState`-calling
  // callback out of the effect — which is what makes React's cascading-render lint
  // rule fire, and for good reason.
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const result = await api.listMigrations();
        if (!cancelled) setJobs(result);
      } catch {
        if (!cancelled) setJobs([]);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey]);

  const remove = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete "${name}" and its logs? The migrated data is not affected.`)) return;
    try {
      await api.deleteMigration(id);
      toast.success('Migration deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete');
    }
  };

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (jobs ?? []).filter((job) => {
      if (filter !== 'all' && job.status !== filter) return false;
      if (needle === '') return true;
      return `${job.name} ${job.source.url} ${job.destination.url}`.toLowerCase().includes(needle);
    });
  }, [jobs, filter, search]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Migration History" description="Every migration, with its outcome and reports.">
        <Button asChild>
          <Link href="/migrations/new">
            <Plus />
            New Migration
          </Link>
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or URL…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                filter === option.id
                  ? 'border-[var(--color-brand-500)]/40 bg-[var(--color-brand-500)]/12 text-[var(--fg)]'
                  : 'border-[var(--line)] text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {jobs === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--line)]" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Database}
              title={(jobs.length === 0) ? 'No migrations yet' : 'Nothing matches'}
              description={
                jobs.length === 0
                  ? 'Create your first migration to move a Supabase project between instances.'
                  : 'Try a different search or filter.'
              }
              action={
                jobs.length === 0 ? (
                  <Button asChild className="mt-1">
                    <Link href="/migrations/new">
                      <Plus />
                      New Migration
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((job) => (
            <HistoryRow key={job.id} job={job} onDelete={() => void remove(job.id, job.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ job, onDelete }: { job: MigrationJob; onDelete: () => void }): React.JSX.Element {
  const done = job.tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  const failed = job.tasks.filter((t) => t.status === 'failed').length;

  return (
    <Card className="glass-hover">
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <Link href={`/migrations/${job.id}`} className="min-w-56 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{job.name}</span>
            <StatusBadge status={job.status} />
            {failed > 0 && (
              <span className="text-xs text-[var(--danger)]">
                {failed} failed task{failed === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-[var(--fg-subtle)]">
            {job.source.url} → {job.destination.url}
          </div>
          <div className="mt-1 text-xs text-[var(--fg-subtle)]">
            {formatRelative(job.startedAt ?? job.createdAt)}
            {job.elapsedMs > 0 && ` · ran for ${formatDuration(job.elapsedMs)}`}
            {job.tasks.length > 0 && ` · ${done}/${job.tasks.length} tasks`}
          </div>
        </Link>

        <div className="hidden shrink-0 gap-6 text-right sm:flex">
          <div>
            <div className="tabular text-sm font-medium">{formatCompact(job.stats.rowsMigrated)}</div>
            <div className="text-[11px] text-[var(--fg-subtle)]">rows</div>
          </div>
          <div>
            <div className="tabular text-sm font-medium">{formatCompact(job.stats.filesMigrated)}</div>
            <div className="text-[11px] text-[var(--fg-subtle)]">files</div>
          </div>
          <div>
            <div className="tabular text-sm font-medium">{formatBytes(job.stats.bytesTransferred)}</div>
            <div className="text-[11px] text-[var(--fg-subtle)]">transferred</div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" asChild title="HTML report">
            <a href={`/api/migrations/${job.id}/report?format=html`} target="_blank" rel="noreferrer">
              <FileText />
            </a>
          </Button>
          <Button variant="ghost" size="icon" asChild title="PDF report">
            <a href={`/api/migrations/${job.id}/report?format=pdf&download=1`}>
              <Download />
            </a>
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} title="Delete">
            <Trash2 />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
