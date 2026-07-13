/**
 * @file The New Migration wizard: connect → discover → select → run.
 *
 * Step 4 is not part of this page. Once the job is created the user is sent to
 * `/migrations/:id`, which is a real, bookmarkable URL backed by a persisted job.
 * Keeping progress out of an ephemeral wizard state is what makes it survivable: you
 * can close the tab, come back tomorrow, and the migration is still there.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Database,
  FileCode2,
  Files,
  FolderTree,
  FunctionSquare,
  Layers,
  Loader2,
  Radio,
  Rocket,
  Rows3,
  Search,
  Shield,
  Table2,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import type { DiscoveryReport, StageId, StageSelection } from '@/core/domain/types';
import { api, ApiClientError } from '@/lib/api';
import { cn, formatBytes, formatNumber } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Label,
} from '@/components/ui/primitives';
import { PageHeader, StatTile } from '@/components/app/shell';
import {
  EndpointForm,
  emptyEndpoint,
  isEndpointReady,
  toCredentials,
  type EndpointState,
} from '@/components/app/endpoint-form';
import type { ApiTestResult, DatabaseTestResult } from '@/core/domain/types';

type Step = 1 | 2 | 3;

const STEPS: readonly { readonly id: Step; readonly label: string }[] = [
  { id: 1, label: 'Connect' },
  { id: 2, label: 'Discovery' },
  { id: 3, label: 'Select' },
];

const ALL_ON: StageSelection = {
  extensions: true,
  tables: true,
  data: true,
  policies: true,
  functions: true,
  views: true,
  triggers: true,
  buckets: true,
  storage_files: true,
  auth_users: true,
  edge_functions: true,
  realtime: true,
};

export default function NewMigrationPage(): React.JSX.Element {
  const router = useRouter();

  const [step, setStep] = React.useState<Step>(1);
  const [name, setName] = React.useState('');

  const [source, setSource] = React.useState<EndpointState>(() => emptyEndpoint('cloud'));
  const [destination, setDestination] = React.useState<EndpointState>(() => emptyEndpoint('self_hosted'));

  // Two results per endpoint, because the API and the database are independent systems
  // that fail independently — especially when self-hosted.
  const [sourceApi, setSourceApi] = React.useState<ApiTestResult | null>(null);
  const [sourceDb, setSourceDb] = React.useState<DatabaseTestResult | null>(null);
  const [destApi, setDestApi] = React.useState<ApiTestResult | null>(null);
  const [destDb, setDestDb] = React.useState<DatabaseTestResult | null>(null);

  const [discovery, setDiscovery] = React.useState<DiscoveryReport | null>(null);
  const [discovering, setDiscovering] = React.useState(false);
  const [selection, setSelection] = React.useState<StageSelection>(ALL_ON);
  const [creating, setCreating] = React.useState(false);

  const bothConnected =
    isEndpointReady(source, sourceApi, sourceDb) && isEndpointReady(destination, destApi, destDb);

  const runDiscovery = async (): Promise<void> => {
    setDiscovering(true);
    try {
      const report = await api.discover(toCredentials(source));
      setDiscovery(report);
      setStep(2);

      // Turn off what the source simply does not have, so the user is not staring at a
      // checkbox for "Edge Functions" on a project with none.
      setSelection((current) => ({
        ...current,
        buckets: report.counts.buckets > 0,
        storage_files: report.counts.files > 0,
        auth_users: report.counts.authUsers > 0,
        edge_functions: report.counts.edgeFunctions > 0,
        realtime: report.realtimeEnabled,
        views: report.counts.views + report.counts.materializedViews > 0,
        triggers: report.counts.triggers > 0,
        functions: report.counts.functions > 0,
        policies: report.counts.policies > 0,
      }));
    } catch (err) {
      toast.error('Discovery failed', {
        description: err instanceof ApiClientError ? err.message : 'Could not inspect the source project',
      });
    } finally {
      setDiscovering(false);
    }
  };

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const job = await api.createMigration({
        name: name.trim() !== '' ? name.trim() : defaultName(source, destination),
        source: toCredentials(source),
        destination: toCredentials(destination),
        selection,
      });

      // Kick it off immediately — the user pressed "Start Migration", not "Save Draft".
      await api.control(job.id, 'start');
      router.push(`/migrations/${job.id}`);
    } catch (err) {
      toast.error('Could not start the migration', {
        description: err instanceof ApiClientError ? err.message : 'Unexpected error',
      });
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="New Migration"
        description="Move an entire Supabase project — schema, data, storage, auth, edge functions."
      />

      <Stepper current={step} />

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <EndpointForm
              role="source"
              value={source}
              onChange={setSource}
              apiResult={sourceApi}
              onApiResult={setSourceApi}
              dbResult={sourceDb}
              onDbResult={setSourceDb}
            />
            <EndpointForm
              role="destination"
              value={destination}
              onChange={setDestination}
              apiResult={destApi}
              onApiResult={setDestApi}
              dbResult={destDb}
              onDbResult={setDestDb}
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            {!bothConnected && (
              <p className="text-sm text-[var(--fg-subtle)]">
                Both endpoints must be reachable to continue.
              </p>
            )}
            <Button size="lg" disabled={!bothConnected} loading={discovering} onClick={() => void runDiscovery()}>
              <Search />
              Discover source
              <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && discovery !== null && (
        <DiscoveryStep
          report={discovery}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && discovery !== null && (
        <SelectionStep
          report={discovery}
          selection={selection}
          onChange={setSelection}
          name={name}
          onName={setName}
          placeholder={defaultName(source, destination)}
          creating={creating}
          onBack={() => setStep(2)}
          onStart={() => void create()}
        />
      )}
    </div>
  );
}

function defaultName(source: EndpointState, destination: EndpointState): string {
  const label = (state: EndpointState): string => {
    try {
      return new URL(state.url).hostname.split('.')[0] ?? state.type;
    } catch {
      return state.type === 'cloud' ? 'cloud' : 'self-hosted';
    }
  };
  return `${label(source)} → ${label(destination)}`;
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

function Stepper({ current }: { current: Step }): React.JSX.Element {
  return (
    <div className="mb-6 flex items-center gap-2">
      {STEPS.map((step, index) => {
        const done = current > step.id;
        const active = current === step.id;

        return (
          <React.Fragment key={step.id}>
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  'grid size-7 place-items-center rounded-full border text-xs font-semibold transition-colors',
                  done && 'border-[var(--ok)] bg-[var(--ok)] text-white',
                  active && 'border-[var(--color-brand-500)] bg-[var(--color-brand-500)] text-white',
                  !done && !active && 'border-[var(--line)] text-[var(--fg-subtle)]',
                )}
              >
                {done ? <CheckCircle2 className="size-4" /> : step.id}
              </div>
              <span
                className={cn(
                  'text-sm transition-colors',
                  active ? 'font-medium text-[var(--fg)]' : 'text-[var(--fg-subtle)]',
                )}
              >
                {step.label}
              </span>
            </div>
            {index < STEPS.length - 1 && (
              <div className={cn('h-px flex-1', done ? 'bg-[var(--ok)]' : 'bg-[var(--line)]')} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Discovery
// ---------------------------------------------------------------------------

function DiscoveryStep({
  report,
  onBack,
  onNext,
}: {
  report: DiscoveryReport;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-4 text-[var(--info)]" />
            Source project
          </CardTitle>
          <CardDescription>Inspected {new Date(report.generatedAt).toLocaleString()}.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge tone="brand">{report.instanceType === 'cloud' ? 'Supabase Cloud' : 'Self Hosted'}</Badge>
            {report.projectRef !== null && <Badge tone="neutral">ref: {report.projectRef}</Badge>}
            {report.postgresVersion !== null && <Badge tone="neutral">PostgreSQL {report.postgresVersion}</Badge>}
            {report.supabaseVersion !== null && <Badge tone="neutral">Supabase {report.supabaseVersion}</Badge>}
            <Badge tone="neutral">via {report.transport.replace(/_/g, ' ')}</Badge>
            {report.realtimeEnabled && (
              <Badge tone="ok">
                <Radio className="size-3" />
                Realtime · {report.realtimeTables} table(s)
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Tables" value={formatNumber(report.counts.tables)} icon={Table2} tone="brand" />
        <StatTile
          label="Rows (est.)"
          value={formatNumber(report.counts.estimatedRows)}
          hint={formatBytes(report.databaseBytes)}
          icon={Rows3}
        />
        <StatTile
          label="Buckets"
          value={formatNumber(report.counts.buckets)}
          hint={`${formatNumber(report.counts.files)} files`}
          icon={Boxes}
        />
        <StatTile
          label="Storage"
          value={formatBytes(report.storageBytes)}
          icon={Files}
          tone={report.storageBytes > 0 ? 'ok' : 'neutral'}
        />
        <StatTile label="Auth users" value={formatNumber(report.counts.authUsers)} icon={Users} />
        <StatTile label="Functions" value={formatNumber(report.counts.functions)} icon={FunctionSquare} />
        <StatTile
          label="Views"
          value={formatNumber(report.counts.views + report.counts.materializedViews)}
          hint={report.counts.materializedViews > 0 ? `${report.counts.materializedViews} materialized` : undefined}
          icon={Layers}
        />
        <StatTile label="Triggers" value={formatNumber(report.counts.triggers)} icon={Workflow} />
        <StatTile
          label="RLS policies"
          value={formatNumber(report.counts.policies)}
          icon={Shield}
          tone={report.counts.policies > 0 ? 'ok' : 'warn'}
        />
        <StatTile label="Extensions" value={formatNumber(report.counts.extensions)} icon={Zap} />
        <StatTile label="Edge functions" value={formatNumber(report.counts.edgeFunctions)} icon={FileCode2} />
        <StatTile label="Schemas" value={formatNumber(report.counts.schemas)} icon={FolderTree} />
      </div>

      {/* The per-schema breakdown is the proof that this tool is not "public-only".
          Managed schemas are shown with a badge explaining that only their data moves. */}
      <Card>
        <CardHeader>
          <CardTitle>Schemas</CardTitle>
          <CardDescription>
            Every non-system schema is migrated, not just <code className="font-mono text-xs">public</code>.
            Supabase-managed schemas have their data migrated but keep the destination&apos;s own structure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wider text-[var(--fg-subtle)]">
                  <th className="pb-2 font-medium">Schema</th>
                  <th className="pb-2 text-right font-medium">Tables</th>
                  <th className="pb-2 text-right font-medium">Rows</th>
                  <th className="pb-2 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {report.schemaBreakdown.map((schema) => (
                  <tr key={schema.schema} className="border-b border-[var(--line)] last:border-0">
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{schema.schema}</span>
                        {schema.managed && (
                          <Badge tone="neutral" className="text-[10px]">
                            data only
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="tabular py-2 text-right">{formatNumber(schema.tables)}</td>
                    <td className="tabular py-2 text-right text-[var(--fg-muted)]">{formatNumber(schema.rows)}</td>
                    <td className="tabular py-2 text-right text-[var(--fg-muted)]">{formatBytes(schema.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {report.buckets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Storage buckets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.buckets.map((bucket) => (
              <div
                key={bucket.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--input-bg)] p-3"
              >
                <Boxes className="size-4 shrink-0 text-[var(--fg-subtle)]" />
                <span className="flex-1 truncate font-mono text-xs">{bucket.name}</span>
                <Badge tone={bucket.public ? 'warn' : 'neutral'}>{bucket.public ? 'public' : 'private'}</Badge>
                <span className="tabular w-20 text-right text-xs text-[var(--fg-muted)]">
                  {formatNumber(bucket.objectCount)} files
                </span>
                <span className="tabular w-20 text-right text-xs text-[var(--fg-muted)]">
                  {formatBytes(bucket.bytes)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {report.warnings.length > 0 && (
        <Card className="border-[var(--warn)]/30">
          <CardHeader>
            <CardTitle className="text-[var(--warn)]">Warnings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.warnings.map((warning) => (
              <p key={warning} className="text-sm leading-relaxed text-[var(--fg-muted)]">
                {warning}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <Button size="lg" onClick={onNext}>
          Choose what to migrate
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Selection
// ---------------------------------------------------------------------------

interface StageOption {
  readonly id: StageId;
  readonly label: string;
  readonly description: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly count: (report: DiscoveryReport) => number;
}

const STAGE_OPTIONS: readonly StageOption[] = [
  {
    id: 'tables',
    label: 'Tables',
    description: 'Columns, primary keys, constraints, indexes, foreign keys, sequences and types.',
    icon: Table2,
    count: (r) => r.counts.tables,
  },
  {
    id: 'data',
    label: 'Data',
    description: 'Row data, copied in resumable batches with keyset pagination.',
    icon: Rows3,
    count: (r) => r.counts.estimatedRows,
  },
  {
    id: 'policies',
    label: 'RLS Policies',
    description: 'Row-level security policies, recreated and verified.',
    icon: Shield,
    count: (r) => r.counts.policies,
  },
  {
    id: 'functions',
    label: 'Functions',
    description: 'Postgres functions and procedures, with their exact source.',
    icon: FunctionSquare,
    count: (r) => r.counts.functions,
  },
  {
    id: 'views',
    label: 'Views',
    description: 'Views and materialized views, created in dependency order.',
    icon: Layers,
    count: (r) => r.counts.views + r.counts.materializedViews,
  },
  {
    id: 'triggers',
    label: 'Triggers',
    description: 'Triggers, applied after the data copy so they do not fire on migrated rows.',
    icon: Workflow,
    count: (r) => r.counts.triggers,
  },
  {
    id: 'buckets',
    label: 'Buckets',
    description: 'Storage buckets, preserving visibility, size limits and MIME restrictions.',
    icon: Boxes,
    count: (r) => r.counts.buckets,
  },
  {
    id: 'storage_files',
    label: 'Storage Files',
    description: 'Every object, streamed with content type, cache control and folder structure intact.',
    icon: Files,
    count: (r) => r.counts.files,
  },
  {
    id: 'auth_users',
    label: 'Auth Users',
    description: 'Users with their password hashes and ids, plus identities, MFA factors and sessions.',
    icon: Users,
    count: (r) => r.counts.authUsers,
  },
  {
    id: 'edge_functions',
    label: 'Edge Functions',
    description: 'Deno functions, redeployed to the destination. Requires a Cloud destination.',
    icon: FileCode2,
    count: (r) => r.counts.edgeFunctions,
  },
  {
    id: 'extensions',
    label: 'Extensions',
    description: 'Postgres extensions, excluding the ones Supabase manages itself.',
    icon: Zap,
    count: (r) => r.counts.extensions,
  },
  {
    id: 'realtime',
    label: 'Realtime',
    description: 'The supabase_realtime publication, so the destination broadcasts the same tables.',
    icon: Radio,
    count: (r) => r.realtimeTables,
  },
];

function SelectionStep({
  report,
  selection,
  onChange,
  name,
  onName,
  placeholder,
  creating,
  onBack,
  onStart,
}: {
  report: DiscoveryReport;
  selection: StageSelection;
  onChange: (next: StageSelection) => void;
  name: string;
  onName: (next: string) => void;
  placeholder: string;
  creating: boolean;
  onBack: () => void;
  onStart: () => void;
}): React.JSX.Element {
  const selectedCount = Object.values(selection).filter(Boolean).length;

  const toggle = (id: StageId): void => {
    onChange({ ...selection, [id]: !selection[id] });
  };

  const setAll = (value: boolean): void => {
    const next = { ...selection };
    for (const option of STAGE_OPTIONS) next[option.id] = value;
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Migration name</CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Name" htmlFor="migration-name" hint="optional">
            <Input
              id="migration-name"
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder={placeholder}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>What to migrate</CardTitle>
            <CardDescription>{selectedCount} of {STAGE_OPTIONS.length} selected.</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              All
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
              None
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {STAGE_OPTIONS.map((option) => {
            const checked = selection[option.id];
            const count = option.count(report);
            const empty = count === 0;

            return (
              <label
                key={option.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors',
                  checked
                    ? 'border-[var(--color-brand-500)]/45 bg-[var(--color-brand-500)]/8'
                    : 'border-[var(--line)] bg-[var(--input-bg)] hover:border-[var(--color-brand-500)]/25',
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(option.id)}
                  className="mt-0.5"
                  id={`stage-${option.id}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <option.icon className="size-4 shrink-0 text-[var(--fg-subtle)]" />
                    <Label htmlFor={`stage-${option.id}`} className="cursor-pointer">
                      {option.label}
                    </Label>
                    {/* Showing the count next to each checkbox turns an abstract choice
                        into a concrete one: "Storage Files — 0" tells the user at a
                        glance that ticking it would do nothing. */}
                    <Badge tone={empty ? 'neutral' : 'brand'} className="ml-auto shrink-0 text-[10px]">
                      {empty ? 'none' : formatNumber(count)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">{option.description}</p>
                </div>
              </label>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack} disabled={creating}>
          <ArrowLeft />
          Back
        </Button>
        <Button
          size="lg"
          variant="accent"
          onClick={onStart}
          loading={creating}
          disabled={selectedCount === 0}
        >
          {creating ? <Loader2 /> : <Rocket />}
          Start Migration
        </Button>
      </div>
    </div>
  );
}
