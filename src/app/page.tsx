/**
 * @file Dashboard — aggregate state across every migration, plus quick actions.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  FileClock,
  HardDrive,
  Loader2,
  Plus,
  Rows3,
  Users,
} from 'lucide-react';
import type { MigrationJob } from '@/core/domain/types';
import { api } from '@/lib/api';
import { formatBytes, formatCompact, formatRelative } from '@/lib/utils';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { PageHeader, StatTile } from '@/components/app/shell';
import { StatusBadge } from '@/components/app/status-badge';

export default function DashboardPage(): React.JSX.Element {
  const [jobs, setJobs] = React.useState<readonly MigrationJob[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const result = await api.listMigrations();
        if (!cancelled) {
          setJobs(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load migrations');
      }
    };

    void load();
    // The progress page uses SSE for per-row detail; the dashboard only needs coarse
    // counts, so a poll is plenty and avoids holding an event stream open on a page
    // nobody is watching closely.
    const timer = setInterval(() => void load(), 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const totals = React.useMemo(() => {
    const list = jobs ?? [];
    return {
      total: list.length,
      running: list.filter((j) => j.status === 'running').length,
      completed: list.filter((j) => j.status === 'completed').length,
      attention: list.filter(
        (j) => j.status === 'failed' || j.status === 'completed_with_errors' || j.status === 'paused',
      ).length,
      rows: list.reduce((sum, j) => sum + j.stats.rowsMigrated, 0),
      files: list.reduce((sum, j) => sum + j.stats.filesMigrated, 0),
      bytes: list.reduce((sum, j) => sum + j.stats.bytesTransferred, 0),
      users: list.reduce((sum, j) => sum + j.stats.usersMigrated, 0),
    };
  }, [jobs]);

  const recent = (jobs ?? []).slice(0, 6);
  const active = (jobs ?? []).filter((j) => j.status === 'running' || j.status === 'paused');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Dashboard" description="Every Supabase migration this instance has run.">
        <Button asChild>
          <Link href="/migrations/new">
            <Plus />
            New Migration
          </Link>
        </Button>
      </PageHeader>

      {error !== null && (
        <Card className="mb-6 border-[var(--danger)]/30">
          <CardContent className="flex items-center gap-3 pt-5">
            <AlertTriangle className="size-5 shrink-0 text-[var(--danger)]" />
            <p className="text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Migrations"
          value={jobs === null ? '—' : String(totals.total)}
          hint={`${totals.running} running · ${totals.completed} completed`}
          icon={FileClock}
          tone="brand"
        />
        <StatTile
          label="Rows migrated"
          value={jobs === null ? '—' : formatCompact(totals.rows)}
          hint="across all migrations"
          icon={Rows3}
          tone="ok"
        />
        <StatTile
          label="Data transferred"
          value={jobs === null ? '—' : formatBytes(totals.bytes)}
          hint={`${formatCompact(totals.files)} files`}
          icon={HardDrive}
        />
        <StatTile
          label="Auth users"
          value={jobs === null ? '—' : formatCompact(totals.users)}
          hint={totals.attention > 0 ? `${totals.attention} migration(s) need attention` : 'all healthy'}
          icon={Users}
          tone={totals.attention > 0 ? 'warn' : 'neutral'}
        />
      </div>

      {active.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-[var(--info)]" />
              In progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {active.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Recent migrations</CardTitle>
          {recent.length > 0 && (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/migrations">
                View all
                <ArrowRight />
              </Link>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {jobs === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--line)]" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={Database}
              title="No migrations yet"
              description="Connect a source and a destination Supabase project to move schema, data, storage, auth and edge functions between them."
              action={
                <Button asChild className="mt-1">
                  <Link href="/migrations/new">
                    <Plus />
                    Create your first migration
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {recent.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function JobRow({ job }: { job: MigrationJob }): React.JSX.Element {
  const done = job.tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  const progress = job.tasks.length > 0 ? Math.round((done / job.tasks.length) * 100) : 0;

  return (
    <Link href={`/migrations/${job.id}`} className="glass glass-hover flex items-center gap-4 rounded-xl p-3.5">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-[var(--input-bg)]">
        {job.status === 'completed' ? (
          <CheckCircle2 className="size-4 text-[var(--ok)]" />
        ) : job.status === 'running' ? (
          <Loader2 className="size-4 animate-spin text-[var(--info)]" />
        ) : job.status === 'failed' || job.status === 'completed_with_errors' ? (
          <AlertTriangle className="size-4 text-[var(--warn)]" />
        ) : (
          <Database className="size-4 text-[var(--fg-subtle)]" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{job.name}</span>
          <StatusBadge status={job.status} />
        </div>
        <div className="mt-0.5 truncate text-xs text-[var(--fg-subtle)]">
          {job.source.type === 'cloud' ? 'Cloud' : 'Self-hosted'} →{' '}
          {job.destination.type === 'cloud' ? 'Cloud' : 'Self-hosted'}
          {' · '}
          {formatRelative(job.startedAt ?? job.createdAt)}
          {job.tasks.length > 0 && ` · ${done}/${job.tasks.length} tasks`}
        </div>
      </div>

      <div className="hidden shrink-0 text-right sm:block">
        <div className="tabular text-sm font-medium">{formatCompact(job.stats.rowsMigrated)} rows</div>
        <div className="tabular text-xs text-[var(--fg-subtle)]">{formatBytes(job.stats.bytesTransferred)}</div>
      </div>

      {job.status === 'running' && (
        <div className="tabular hidden w-12 shrink-0 text-right text-sm font-medium text-[var(--info)] md:block">
          {progress}%
        </div>
      )}
    </Link>
  );
}
