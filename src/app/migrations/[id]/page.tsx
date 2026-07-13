/**
 * @file Step 4: the live migration page.
 *
 * Driven entirely by the SSE stream. The server is the single source of truth for
 * progress — this page holds no derived state that could drift from it, which is why
 * closing the tab, reopening it, or hard-refreshing mid-migration all land you back
 * exactly where the migration actually is.
 */

'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  Rows3,
  Timer,
  Trash2,
} from 'lucide-react';
import type {
  LogEntry,
  MigrationEvent,
  MigrationJob,
  MigrationStats,
  MigrationTask,
  StageId,
} from '@/core/domain/types';
import { api, ApiClientError } from '@/lib/api';
import { cn, formatBytes, formatDuration, formatNumber, formatRate, percent } from '@/lib/utils';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@/components/ui/primitives';
import { PageHeader, StatTile } from '@/components/app/shell';
import { StatusBadge, TaskStatusBadge, ValidationBadge } from '@/components/app/status-badge';
import { LogViewer } from '@/components/app/log-viewer';
import { ResumeDialog } from '@/components/app/resume-dialog';

/** Stage groups, in the order they run. Each renders as its own progress section. */
const STAGE_GROUPS: readonly { readonly label: string; readonly stages: readonly StageId[] }[] = [
  { label: 'Database', stages: ['extensions', 'tables', 'data', 'functions', 'views', 'triggers', 'policies'] },
  { label: 'Storage', stages: ['buckets', 'storage_files'] },
  { label: 'Auth', stages: ['auth_users'] },
  { label: 'Edge & Realtime', stages: ['edge_functions', 'realtime'] },
];

export default function MigrationPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [job, setJob] = React.useState<MigrationJob | null>(null);
  const [logs, setLogs] = React.useState<readonly LogEntry[]>([]);
  const [throughput, setThroughput] = React.useState({ bytesPerSec: 0, rowsPerSec: 0, etaMs: null as number | null });
  const [elapsed, setElapsed] = React.useState(0);
  const [connected, setConnected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [resumeOpen, setResumeOpen] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);

  /**
   * The event stream.
   *
   * `EventSource` handles reconnection itself, and the server replays its recent
   * buffer on every new subscription — so a dropped socket costs us nothing.
   */
  React.useEffect(() => {
    const source = new EventSource(`/api/migrations/${id}/events`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (message: MessageEvent<string>) => {
      let event: MigrationEvent;
      try {
        event = JSON.parse(message.data) as MigrationEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'snapshot':
          setJob(event.job);
          setElapsed(event.job.elapsedMs);
          break;

        case 'task':
          // Patch the one task in place rather than refetching the job. On a 1000-table
          // migration this is thousands of events; refetching each time would hammer
          // the server and make the page stutter.
          setJob((current) => {
            if (current === null) return current;
            const tasks = current.tasks.map((t) => (t.id === event.task.id ? event.task : t));
            return { ...current, tasks };
          });
          break;

        case 'stats':
          setJob((current) => (current === null ? current : { ...current, stats: event.stats }));
          setElapsed(event.elapsedMs);
          break;

        case 'status':
          setJob((current) => (current === null ? current : { ...current, status: event.status, error: event.error }));
          if (event.status === 'completed') toast.success('Migration completed');
          if (event.status === 'completed_with_errors') toast.warning('Migration finished with errors');
          if (event.status === 'failed') toast.error('Migration failed', { description: event.error ?? undefined });
          break;

        case 'throughput':
          setThroughput({ bytesPerSec: event.bytesPerSec, rowsPerSec: event.rowsPerSec, etaMs: event.etaMs });
          break;

        case 'log':
          // Cap the in-memory buffer. A long migration emits tens of thousands of
          // entries; the full history lives on disk and is searchable from the Logs
          // page, so the live pane only needs the recent tail.
          setLogs((current) => {
            const next = [...current, event.entry];
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
          break;
      }
    };

    return () => source.close();
  }, [id]);

  // The stream only exists for a job that exists. A 404 needs a plain fetch to detect.
  React.useEffect(() => {
    void api.getMigration(id).catch((err: unknown) => {
      if (err instanceof ApiClientError && err.status === 404) setNotFound(true);
    });
  }, [id]);

  const control = async (action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<void> => {
    setBusy(true);
    try {
      await api.control(id, action);
      toast.success(
        action === 'pause'
          ? 'Pausing — progress is being checkpointed'
          : action === 'cancel'
            ? 'Cancelling'
            : 'Resuming from the last checkpoint',
      );
    } catch (err) {
      // The one error worth handling specially: the server no longer holds the keys.
      if (err instanceof ApiClientError && err.code === 'CREDENTIALS_EXPIRED') {
        setResumeOpen(true);
      } else {
        toast.error(err instanceof ApiClientError ? err.message : 'Action failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm('Delete this migration and its logs? The migrated data is not affected.')) return;
    try {
      await api.deleteMigration(id);
      router.push('/migrations');
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete');
    }
  };

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="py-16 text-center">
            <AlertTriangle className="mx-auto mb-3 size-8 text-[var(--warn)]" />
            <h2 className="font-semibold">Migration not found</h2>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">It may have been deleted.</p>
            <Button className="mt-4" variant="outline" onClick={() => router.push('/migrations')}>
              Back to history
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (job === null) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-[var(--line)]" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--line)]" />
          ))}
        </div>
        <div className="h-96 animate-pulse rounded-xl bg-[var(--line)]" />
      </div>
    );
  }

  const done = job.tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  const overall = job.tasks.length > 0 ? (done / job.tasks.length) * 100 : 0;
  const running = job.status === 'running';
  const terminal = job.status === 'completed' || job.status === 'cancelled';
  const currentTask = job.tasks.find((t) => t.status === 'running');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={job.name} description={`${job.source.url} → ${job.destination.url}`}>
        <StatusBadge status={job.status} />

        {running && (
          <Button variant="outline" onClick={() => void control('pause')} loading={busy}>
            <Pause />
            Pause
          </Button>
        )}
        {(job.status === 'paused' || job.status === 'failed' || job.status === 'completed_with_errors' || job.status === 'created') && (
          <Button onClick={() => void control('resume')} loading={busy}>
            <Play />
            {job.status === 'created' ? 'Start' : 'Resume'}
          </Button>
        )}
        {!terminal && (
          <Button variant="ghost" onClick={() => void control('cancel')} disabled={busy}>
            <Ban />
            Cancel
          </Button>
        )}

        <Button variant="ghost" size="icon" asChild title="HTML report">
          <a href={`/api/migrations/${id}/report?format=html`} target="_blank" rel="noreferrer">
            <FileText />
          </a>
        </Button>
        <Button variant="ghost" size="icon" asChild title="PDF report">
          <a href={`/api/migrations/${id}/report?format=pdf&download=1`}>
            <Download />
          </a>
        </Button>
        <Button variant="ghost" size="icon" onClick={() => void remove()} title="Delete">
          <Trash2 />
        </Button>
      </PageHeader>

      {job.error !== null && (
        <Card className="mb-4 border-[var(--danger)]/35">
          <CardContent className="flex gap-3 pt-5">
            <AlertTriangle className="size-5 shrink-0 text-[var(--danger)]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{job.error}</p>
              {job.status === 'paused' && (
                <Button size="sm" className="mt-3" onClick={() => setResumeOpen(true)}>
                  <RefreshCw />
                  Re-enter credentials and resume
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Overall progress */}
      <Card className="mb-4">
        <CardContent className="pt-5">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {currentTask !== undefined ? (
                  <span className="flex items-center gap-2">
                    <Activity className="size-4 animate-pulse text-[var(--info)]" />
                    <span className="truncate">
                      {currentTask.stage.replace(/_/g, ' ')} · {currentTask.label}
                    </span>
                  </span>
                ) : terminal || job.status === 'completed_with_errors' ? (
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-[var(--ok)]" />
                    Finished
                  </span>
                ) : (
                  'Idle'
                )}
              </div>
              <div className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                {done} of {job.tasks.length} tasks
                {!connected && running && ' · reconnecting…'}
              </div>
            </div>
            <div className="tabular shrink-0 text-2xl font-semibold">{Math.round(overall)}%</div>
          </div>
          <Progress value={overall} className="h-2.5" />
        </CardContent>
      </Card>

      {/* Live metrics */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Transfer speed"
          value={running ? formatRate(throughput.bytesPerSec) : '—'}
          hint={running && throughput.rowsPerSec > 0 ? `${formatNumber(Math.round(throughput.rowsPerSec))} rows/s` : undefined}
          icon={Gauge}
          tone="brand"
        />
        <StatTile
          label="ETA"
          value={running ? formatDuration(throughput.etaMs) : '—'}
          hint={`elapsed ${formatDuration(elapsed)}`}
          icon={Timer}
        />
        <StatTile
          label="Rows migrated"
          value={formatNumber(job.stats.rowsMigrated)}
          hint={`${formatNumber(job.stats.filesMigrated)} files · ${formatBytes(job.stats.bytesTransferred)}`}
          icon={Rows3}
          tone="ok"
        />
        <StatTile
          label="Retries"
          value={formatNumber(job.stats.retries)}
          hint={`${formatNumber(job.stats.errors)} errors · ${formatNumber(job.stats.skipped)} skipped`}
          icon={RefreshCw}
          tone={job.stats.errors > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4">
          {STAGE_GROUPS.map((group) => {
            const tasks = job.tasks.filter((t) => group.stages.includes(t.stage));
            if (tasks.length === 0) return null;
            return <StageGroup key={group.label} label={group.label} tasks={tasks} stats={job.stats} />;
          })}

          {job.validation !== null && <ValidationCard job={job} />}
        </div>

        <LogViewer jobId={id} live={logs} />
      </div>

      <ResumeDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        job={job}
        onResumed={() => {
          setResumeOpen(false);
          toast.success('Resuming from the last checkpoint');
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage progress
// ---------------------------------------------------------------------------

function StageGroup({
  label,
  tasks,
  stats,
}: {
  label: string;
  tasks: readonly MigrationTask[];
  stats: MigrationStats;
}): React.JSX.Element {
  void stats;

  const done = tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const groupPercent = tasks.length > 0 ? (done / tasks.length) * 100 : 0;

  // Long task lists (a thousand tables) collapse by default: the interesting ones are
  // whatever is running or has failed, and forcing the user to scroll past 900 green
  // ticks to find the one red one is a hostile default.
  const [expanded, setExpanded] = React.useState(tasks.length <= 8);
  const visible = expanded
    ? tasks
    : tasks.filter((t) => t.status === 'running' || t.status === 'failed').slice(0, 5);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">{label}</CardTitle>
          <div className="flex items-center gap-2">
            {failed > 0 && <Badge tone="danger">{failed} failed</Badge>}
            <span className="tabular text-xs text-[var(--fg-muted)]">
              {done}/{tasks.length}
            </span>
          </div>
        </div>
        <Progress value={groupPercent} className="mt-2" />
      </CardHeader>

      <CardContent className="space-y-1.5 pt-2">
        {visible.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}

        {tasks.length > visible.length && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full rounded-lg py-1.5 text-xs text-[var(--fg-subtle)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--fg)]"
          >
            Show all {tasks.length}
          </button>
        )}
        {expanded && tasks.length > 8 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full rounded-lg py-1.5 text-xs text-[var(--fg-subtle)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--fg)]"
          >
            Collapse
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function TaskRow({ task }: { task: MigrationTask }): React.JSX.Element {
  const value = task.total !== null && task.total > 0 ? percent(task.processed, task.total) : null;
  const isStorage = task.stage === 'storage_files';

  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--input-bg)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={task.label}>
          {task.label}
        </span>
        <span className="tabular shrink-0 text-xs text-[var(--fg-muted)]">
          {isStorage
            ? formatBytes(task.processed)
            : task.total !== null && task.total > 0
              ? `${formatNumber(task.processed)}/${formatNumber(task.total)}`
              : formatNumber(task.processed)}
        </span>
        <TaskStatusBadge status={task.status} />
      </div>

      {task.status === 'running' && (
        <Progress value={value} className="mt-1.5 h-1" />
      )}

      {task.error !== null && (
        <p className="mt-1.5 line-clamp-2 text-xs text-[var(--danger)]" title={task.error}>
          {task.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function ValidationCard({ job }: { job: MigrationJob }): React.JSX.Element | null {
  const validation = job.validation;
  const [showAll, setShowAll] = React.useState(false);

  // Failures and warnings first — nobody opens a validation report to admire the passes.
  const sorted = React.useMemo(() => {
    const rank = { fail: 0, warn: 1, pass: 2 } as const;
    return [...(validation?.checks ?? [])].sort((a, b) => rank[a.status] - rank[b.status]);
  }, [validation]);

  // Hooks must run unconditionally, so the null check comes after them, not before.
  if (validation === null) return null;

  const visible = showAll ? sorted : sorted.slice(0, 8);

  return (
    <Card className={cn(validation.status === 'fail' && 'border-[var(--danger)]/35')}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Validation</CardTitle>
          <ValidationBadge status={validation.status} />
        </div>
        <CardDescription>
          {validation.summary.passed} passed · {validation.summary.warned} warnings · {validation.summary.failed} failed
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-[var(--fg-subtle)]">
              <th className="pb-1.5 font-medium">Check</th>
              <th className="pb-1.5 text-right font-medium">Source</th>
              <th className="pb-1.5 text-right font-medium">Dest</th>
              <th className="pb-1.5 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((check) => (
              <tr key={`${check.category}-${check.label}`} className="border-b border-[var(--line)] last:border-0">
                <td className="py-1.5">
                  <div className="truncate font-mono" title={check.label}>
                    {check.label}
                  </div>
                  {check.note !== undefined && (
                    <div className="text-[11px] text-[var(--fg-subtle)]">{check.note}</div>
                  )}
                </td>
                <td className="tabular py-1.5 text-right">{formatNumber(check.source)}</td>
                <td
                  className={cn(
                    'tabular py-1.5 text-right',
                    check.status === 'fail' && 'text-[var(--danger)]',
                    check.status === 'warn' && 'text-[var(--warn)]',
                  )}
                >
                  {formatNumber(check.destination)}
                </td>
                <td className="py-1.5 pl-2 text-right">
                  <ValidationBadge status={check.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sorted.length > visible.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-2 w-full rounded-lg py-1.5 text-xs text-[var(--fg-subtle)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--fg)]"
          >
            Show all {sorted.length} checks
          </button>
        )}
      </CardContent>
    </Card>
  );
}
