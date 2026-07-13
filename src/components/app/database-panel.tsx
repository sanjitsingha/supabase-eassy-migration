/**
 * @file The Database Connection panel.
 *
 * The whole reason this exists: **a self-hosted Supabase has no Management API**, so
 * the Postgres connection is not a nice-to-have — it is the only channel through which
 * the schema can be read or written. And every deployment topology exposes it
 * differently. Railway and Coolify hand you a URL. Docker Compose gives you an internal
 * hostname (`supabase-db`) that only resolves inside the network. Kubernetes gives you
 * a service DNS name. A reverse proxy fronts the API but not the database at all.
 *
 * So both input forms are first-class and kept in sync: paste a connection string and
 * the fields fill in; edit a field and the string is rebuilt. Neither is the "advanced"
 * one, because which you have depends entirely on who is hosting you.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Info,
  Lightbulb,
  Loader2,
  Plug,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { DatabaseConnection, DatabaseTestResult, PoolerMode, SslMode } from '@/core/domain/types';
import { parseConnectionString, buildConnectionString, CONNECTION_DEFAULTS } from '@/core/transport/postgres-url';
import { cn, formatNumber } from '@/lib/utils';
import {
  Badge,
  Button,
  Collapsible,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
} from '@/components/ui/primitives';

const SSL_OPTIONS: readonly { value: SslMode; label: string }[] = [
  { value: 'prefer', label: 'Prefer — encrypt if the server supports it' },
  { value: 'no-verify', label: 'Require, no verification — self-signed certificates' },
  { value: 'require', label: 'Require, verified — a valid certificate chain' },
  { value: 'disable', label: 'Disable — plaintext (private networks only)' },
];

const POOLER_OPTIONS: readonly { value: PoolerMode; label: string }[] = [
  { value: 'direct', label: 'Direct PostgreSQL — recommended for migrations' },
  { value: 'transaction', label: 'Transaction pooler (Supavisor / PgBouncer, port 6543)' },
  { value: 'session', label: 'Session pooler' },
];

export interface DatabasePanelProps {
  id: string;
  value: DatabaseConnection;
  onChange: (next: DatabaseConnection) => void;
  result: DatabaseTestResult | null;
  onTest: () => void;
  testing: boolean;
  /** Self-hosted cannot migrate without this; Cloud can fall back to the Management API. */
  required: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DatabasePanel({
  id,
  value,
  onChange,
  result,
  onTest,
  testing,
  required,
  open,
  onOpenChange,
}: DatabasePanelProps): React.JSX.Element {
  const [showPassword, setShowPassword] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  /**
   * Keeps the two representations in agreement.
   *
   * Pasting a string fills the fields (so switching to Manual is seamless and the user
   * can see what they actually pasted — including a password they may have got wrong).
   * Editing a field rebuilds the string. Without this, switching modes would silently
   * lose whatever the user had just typed.
   */
  const update = (patch: Partial<DatabaseConnection>): void => {
    let next: DatabaseConnection = { ...value, ...patch };

    if (patch.connectionString !== undefined) {
      const parsed = parseConnectionString(patch.connectionString);
      if (parsed.ok) {
        next = {
          ...next,
          host: parsed.host,
          port: parsed.port,
          database: parsed.database,
          username: parsed.username,
          password: parsed.password,
          ...(parsed.ssl !== null ? { ssl: parsed.ssl } : {}),
        };
      }
    } else if (
      patch.host !== undefined ||
      patch.port !== undefined ||
      patch.database !== undefined ||
      patch.username !== undefined ||
      patch.password !== undefined
    ) {
      next = { ...next, connectionString: buildConnectionString(next) };
    }

    onChange(next);
  };

  const parsed = value.mode === 'connection_string' ? parseConnectionString(value.connectionString ?? '') : null;
  const parseError =
    value.mode === 'connection_string' && (value.connectionString ?? '').trim() !== '' && parsed?.ok === false
      ? parsed.error
      : null;

  const canTest =
    value.mode === 'connection_string'
      ? parsed?.ok === true
      : (value.host ?? '').trim() !== '';

  return (
    <Collapsible
      title="Database Connection"
      description={
        required
          ? 'Required — self-hosted Supabase has no Management API, so this is the only way to read the schema.'
          : 'Optional on Cloud when a Personal Access Token is supplied.'
      }
      icon={Database}
      open={open}
      onOpenChange={onOpenChange}
      badge={
        result === null ? (
          required ? <Badge tone="warn">Required</Badge> : undefined
        ) : result.ok ? (
          <Badge tone="ok">
            <CheckCircle2 className="size-3" />
            PostgreSQL {result.version ?? 'connected'}
          </Badge>
        ) : (
          <Badge tone="danger">
            <XCircle className="size-3" />
            Failed
          </Badge>
        )
      }
    >
      {/* Mode ------------------------------------------------------------ */}
      <div className="space-y-2">
        <Label>Connection Mode</Label>
        <RadioGroup
          value={value.mode}
          onValueChange={(mode) => update({ mode: mode as DatabaseConnection['mode'] })}
          className="grid grid-cols-2 gap-2"
        >
          {(
            [
              ['connection_string', 'Connection String'],
              ['manual', 'Manual'],
            ] as const
          ).map(([mode, label]) => (
            <label
              key={mode}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-sm transition-colors',
                value.mode === mode
                  ? 'border-[var(--color-brand-500)]/50 bg-[var(--color-brand-500)]/8'
                  : 'border-[var(--line)] hover:border-[var(--color-brand-500)]/30',
              )}
            >
              <RadioGroupItem value={mode} id={`${id}-mode-${mode}`} />
              {label}
            </label>
          ))}
        </RadioGroup>
      </div>

      {/* Connection string ------------------------------------------------ */}
      {value.mode === 'connection_string' ? (
        <div className="space-y-3">
          <Field
            label="Postgres Connection String"
            htmlFor={`${id}-connstr`}
            required
            error={parseError}
          >
            <Input
              id={`${id}-connstr`}
              type={showPassword ? 'text' : 'password'}
              value={value.connectionString ?? ''}
              onChange={(e) => update({ connectionString: e.target.value })}
              placeholder="postgresql://postgres:password@host:5432/postgres"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>

          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg)]"
          >
            {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {showPassword ? 'Hide' : 'Reveal'} connection string
          </button>

          {/* Echo back what we parsed. This is what catches a password containing an
              unencoded `@`, which otherwise mangles the host and produces a baffling
              "could not resolve" error. */}
          {parsed?.ok === true && (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--glass-bg)] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs text-[var(--fg-subtle)]">
                <Info className="size-3.5" />
                Parsed as
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-5">
                <ParsedField label="Host" value={parsed.host} />
                <ParsedField label="Port" value={String(parsed.port)} />
                <ParsedField label="Database" value={parsed.database} />
                <ParsedField label="Username" value={parsed.username} />
                <ParsedField label="Password" value={parsed.password === '' ? '—' : '••••••••'} />
              </dl>
            </div>
          )}
        </div>
      ) : (
        /* Manual fields -------------------------------------------------- */
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Host" htmlFor={`${id}-host`} required hint="hostname or IP">
              <Input
                id={`${id}-host`}
                value={value.host ?? ''}
                onChange={(e) => update({ host: e.target.value })}
                placeholder="supabase-db"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">
                On Docker or Kubernetes use the internal service name (
                <code className="font-mono">supabase-db</code>). Otherwise an IP (
                <code className="font-mono">192.168.1.10</code>) or a hostname (
                <code className="font-mono">db.example.com</code>).
              </p>
            </Field>
          </div>

          <Field label="Port" htmlFor={`${id}-port`}>
            <Input
              id={`${id}-port`}
              type="number"
              value={value.port ?? CONNECTION_DEFAULTS.port}
              onChange={(e) => update({ port: Number.parseInt(e.target.value, 10) || CONNECTION_DEFAULTS.port })}
              placeholder="5432"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Database" htmlFor={`${id}-database`}>
            <Input
              id={`${id}-database`}
              value={value.database ?? ''}
              onChange={(e) => update({ database: e.target.value })}
              placeholder="postgres"
              autoComplete="off"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Username" htmlFor={`${id}-username`}>
            <Input
              id={`${id}-username`}
              value={value.username ?? ''}
              onChange={(e) => update({ username: e.target.value })}
              placeholder="postgres"
              autoComplete="off"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Password" htmlFor={`${id}-password`} required>
            <div className="relative">
              <Input
                id={`${id}-password`}
                type={showPassword ? 'text' : 'password'}
                value={value.password ?? ''}
                onChange={(e) => update({ password: e.target.value })}
                placeholder="••••••••"
                autoComplete="off"
                className="pr-10 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--fg-subtle)] transition-colors hover:text-[var(--fg)]"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
        </div>
      )}

      {/* Advanced --------------------------------------------------------- */}
      <Collapsible
        title="Advanced"
        description="SSL, pooler mode, connection timeout"
        icon={ShieldCheck}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <Field label="SSL" htmlFor={`${id}-ssl`}>
          <Select
            id={`${id}-ssl`}
            value={value.ssl}
            onChange={(e) => update({ ssl: e.target.value as SslMode })}
            options={SSL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">
            Self-hosted Postgres usually presents a self-signed certificate, so
            &ldquo;Require, no verification&rdquo; is the common choice. Use
            &ldquo;Disable&rdquo; on a private network.
          </p>
        </Field>

        <Field label="Pooler Mode" htmlFor={`${id}-pooler`}>
          <Select
            id={`${id}-pooler`}
            value={value.poolerMode}
            onChange={(e) => update({ poolerMode: e.target.value as PoolerMode })}
            options={POOLER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">
            Prefer Direct PostgreSQL. A transaction pooler cannot hold session state or
            prepared statements, which schema work depends on — poolers are built for
            application traffic, not migrations.
          </p>
        </Field>

        <Field label="Connection Timeout" htmlFor={`${id}-timeout`} hint="milliseconds">
          <Input
            id={`${id}-timeout`}
            type="number"
            value={value.connectionTimeoutMs}
            onChange={(e) =>
              update({
                connectionTimeoutMs:
                  Number.parseInt(e.target.value, 10) || CONNECTION_DEFAULTS.connectionTimeoutMs,
              })
            }
            className="font-mono text-xs"
          />
        </Field>
      </Collapsible>

      {/* Test ------------------------------------------------------------- */}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onTest} disabled={!canTest} loading={testing}>
          <Plug />
          Test PostgreSQL
        </Button>
        {!canTest && (
          <span className="text-xs text-[var(--fg-subtle)]">
            {value.mode === 'connection_string' ? 'Enter a connection string' : 'Enter a host'}
          </span>
        )}
      </div>

      {result !== null && <DatabaseResult result={result} />}
    </Collapsible>
  );
}

function ParsedField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</dt>
      <dd className="truncate font-mono text-[var(--fg)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function DatabaseResult({ result }: { result: DatabaseTestResult }): React.JSX.Element {
  if (!result.ok) {
    return (
      <div className="space-y-3 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger)]/8 p-3.5">
        <div className="flex gap-2.5">
          <XCircle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{result.error}</p>
            {result.errorCode !== null && (
              <code className="mt-1 inline-block rounded bg-[var(--danger)]/12 px-1.5 py-0.5 font-mono text-[11px] text-[var(--danger)]">
                {result.errorCode}
              </code>
            )}
          </div>
        </div>

        {result.pooler !== null && (
          <Badge tone="warn">
            <AlertTriangle className="size-3" />
            {result.pooler === 'supavisor' ? 'Supavisor detected' : 'PgBouncer detected'}
          </Badge>
        )}

        {/* The hints are the point of the whole panel. An `ENOIDENTIFIER` with no
            explanation is one of the least actionable errors in the Supabase ecosystem. */}
        {result.hints.length > 0 && (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--glass-bg)] p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              <Lightbulb className="size-3.5 text-[var(--warn)]" />
              How to fix this
            </div>
            <ul className="space-y-1.5">
              {result.hints.map((hint) => (
                <li key={hint} className="flex gap-2 text-xs leading-relaxed text-[var(--fg-muted)]">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--fg-subtle)]" />
                  <span>{hint}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--ok)]/35 bg-[var(--ok)]/8 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <CheckCircle2 className="size-4 shrink-0 text-[var(--ok)]" />
        <span className="text-sm font-medium">PostgreSQL {result.version}</span>
        <span className="text-xs text-[var(--fg-muted)]">
          Connected as <code className="font-mono">{result.user}</code> · database{' '}
          <code className="font-mono">{result.database}</code>
        </span>
        <span className="tabular ml-auto text-xs text-[var(--fg-subtle)]">{result.latencyMs}ms</span>
      </div>

      {result.pooler !== null && (
        <Badge tone="warn">
          <AlertTriangle className="size-3" />
          Reached via {result.pooler === 'supavisor' ? 'Supavisor' : 'PgBouncer'}
        </Badge>
      )}

      <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {result.permissions.map((permission) => (
          <div key={permission.key} className="flex items-start gap-1.5 text-xs">
            {permission.granted ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--ok)]" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" />
            )}
            <div className="min-w-0">
              <span className={permission.granted ? '' : 'text-[var(--fg-subtle)]'}>{permission.label}</span>
              {!permission.granted && permission.key !== 'superuser' && (
                <p className="mt-0.5 leading-relaxed text-[var(--fg-subtle)]">{permission.required}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {result.extensions.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--fg-subtle)] hover:text-[var(--fg-muted)]">
            {formatNumber(result.extensions.length)} extension
            {result.extensions.length === 1 ? '' : 's'} installed
          </summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {result.extensions.map((extension) => (
              <Badge key={extension.name} tone="neutral" className="font-mono text-[10px]">
                {extension.name} {extension.version}
              </Badge>
            ))}
          </div>
        </details>
      )}

      {result.hints.map((hint) => (
        <div key={hint} className="flex gap-2 text-xs text-[var(--warn)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="leading-relaxed">{hint}</span>
        </div>
      ))}
    </div>
  );
}

/** A spinner row shown while the test is in flight, so the panel does not just freeze. */
export function DatabaseTesting(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--input-bg)] p-3 text-xs text-[var(--fg-muted)]">
      <Loader2 className="size-3.5 animate-spin" />
      Connecting to PostgreSQL…
    </div>
  );
}
