/**
 * @file Step 1: the source/destination connection panel.
 *
 * Structured around the fact that a Supabase endpoint is really **two independent
 * systems** — an HTTP API behind a gateway, and a Postgres server — and that on a
 * self-hosted deployment they routinely live on different hosts, different networks,
 * and fail for entirely unrelated reasons. So they get separate sections, separate
 * test buttons, and separate diagnostics. A single "Test Connection" that reports
 * "failed" tells a user nothing about which half to go and fix.
 *
 * The database section is *required* for self-hosted and expanded by default, because
 * self-hosted Supabase ships no Management API: without a Postgres connection there is
 * no way to read a schema at all, and pretending it is optional would set the user up
 * to fail at Step 4.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Server,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  ApiTestResult,
  DatabaseConnection,
  DatabaseTestResult,
  EndpointRole,
  InstanceType,
  ServiceProbe,
  SupabaseCredentials,
} from '@/core/domain/types';
import { api, ApiClientError } from '@/lib/api';
import { inspectKey } from '@/core/transport/jwt';
import { emptyConnection } from '@/core/transport/postgres-url';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/primitives';
import { DatabasePanel } from '@/components/app/database-panel';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface EndpointState {
  type: InstanceType;
  url: string;
  serviceRoleKey: string;
  accessToken: string;
  database: DatabaseConnection;
}

export function emptyEndpoint(type: InstanceType = 'cloud'): EndpointState {
  return {
    type,
    url: '',
    serviceRoleKey: '',
    accessToken: '',
    database: emptyConnection('connection_string'),
  };
}

/** Form state → the credentials the API expects. */
export function toCredentials(state: EndpointState): SupabaseCredentials {
  const hasTarget =
    state.database.mode === 'connection_string'
      ? (state.database.connectionString ?? '').trim() !== ''
      : (state.database.host ?? '').trim() !== '';

  return {
    type: state.type,
    url: state.url.trim(),
    serviceRoleKey: state.serviceRoleKey.trim(),
    ...(state.accessToken.trim() !== '' ? { accessToken: state.accessToken.trim() } : {}),
    ...(hasTarget ? { database: state.database } : {}),
  };
}

/** True when this endpoint is ready to migrate — API reachable, and a usable SQL channel. */
export function isEndpointReady(
  state: EndpointState,
  apiResult: ApiTestResult | null,
  dbResult: DatabaseTestResult | null,
): boolean {
  if (apiResult?.ok !== true) return false;

  // Self-hosted has no Management API, so Postgres is the only SQL channel there is.
  if (state.type === 'self_hosted') return dbResult?.ok === true;

  // Cloud can go through the Management API with a PAT, or through Postgres.
  return state.accessToken.trim() !== '' || dbResult?.ok === true;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface EndpointFormProps {
  role: EndpointRole;
  value: EndpointState;
  onChange: (next: EndpointState) => void;
  apiResult: ApiTestResult | null;
  onApiResult: (result: ApiTestResult | null) => void;
  dbResult: DatabaseTestResult | null;
  onDbResult: (result: DatabaseTestResult | null) => void;
}

export function EndpointForm({
  role,
  value,
  onChange,
  apiResult,
  onApiResult,
  dbResult,
  onDbResult,
}: EndpointFormProps): React.JSX.Element {
  const [testingApi, setTestingApi] = React.useState(false);
  const [testingDb, setTestingDb] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [dbOpen, setDbOpen] = React.useState(value.type === 'self_hosted');

  const isSource = role === 'source';
  const selfHosted = value.type === 'self_hosted';

  // Validate the key locally, as it is typed. Catches the single most common setup
  // mistake — pasting the anon key — without a round trip.
  const keyInspection = React.useMemo(
    () => (value.serviceRoleKey.trim() === '' ? null : inspectKey(value.serviceRoleKey)),
    [value.serviceRoleKey],
  );

  const urlValid = React.useMemo(() => isValidUrl(value.url), [value.url]);

  const set = <K extends keyof EndpointState>(key: K, next: EndpointState[K]): void => {
    const updated = { ...value, [key]: next };

    // Switching instance type changes what is required, so open the database panel
    // when it becomes mandatory.
    if (key === 'type') {
      setDbOpen(next === 'self_hosted');
    }

    onChange(updated);

    // Any credential change invalidates the previous result. A green tick next to a
    // URL the user has since edited is a lie.
    if (key === 'url' || key === 'serviceRoleKey') {
      onApiResult(null);
      setApiError(null);
    }
  };

  const setDatabase = (next: DatabaseConnection): void => {
    onChange({ ...value, database: next });
    onDbResult(null);
  };

  const testApiConnection = React.useCallback(async (): Promise<void> => {
    setTestingApi(true);
    setApiError(null);
    try {
      const result = await api.testApi(toCredentials(value));
      onApiResult(result);

      // Auto-detection. Once the API answers we know a hostname that is at least
      // plausible for Postgres too — right for a plain Docker Compose box where Kong
      // and the database share a machine. When it is wrong (behind a proxy, on
      // Coolify, on Kubernetes) the user overrides it, but the common case costs them
      // nothing. Only ever a suggestion into an empty field; never an overwrite.
      if (result.ok && selfHosted) {
        const host = hostFromUrl(value.url);
        const untouched =
          (value.database.connectionString ?? '').trim() === '' && (value.database.host ?? '').trim() === '';

        if (host !== null && untouched) {
          onChange({
            ...value,
            database: { ...value.database, mode: 'manual', host },
          });
          setDbOpen(true);
        }
      }
    } catch (err) {
      onApiResult(null);
      setApiError(err instanceof ApiClientError ? err.message : 'The API test failed.');
    } finally {
      setTestingApi(false);
    }
  }, [value, onApiResult, onChange, selfHosted]);

  const testDatabaseConnection = React.useCallback(async (): Promise<void> => {
    setTestingDb(true);
    try {
      onDbResult(await api.testDatabase(toCredentials(value)));
    } catch (err) {
      onDbResult(null);
      setApiError(err instanceof ApiClientError ? err.message : 'The database test failed.');
    } finally {
      setTestingDb(false);
    }
  }, [value, onDbResult]);

  /**
   * Re-test the database automatically when the target changes.
   *
   * Only *after* a first successful test, and debounced — so it feels like the field
   * is live rather than like the form is firing connections at every keystroke. Tuning
   * a host or a port is exactly the moment you want instant feedback, and it is the
   * moment a manual "test" button is most annoying.
   */
  const target = `${value.database.mode}|${value.database.host ?? ''}|${value.database.port ?? ''}|${value.database.connectionString ?? ''}|${value.database.ssl}|${value.database.poolerMode}`;
  const hasTestedDb = dbResult !== null;
  const firstRun = React.useRef(true);

  React.useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!hasTestedDb) return;

    const timer = setTimeout(() => void testDatabaseConnection(), 900);
    return () => clearTimeout(timer);
    // `testDatabaseConnection` is intentionally omitted: it changes identity on every
    // keystroke (it closes over `value`), which would reset the debounce timer forever
    // and mean the re-test never actually fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const canTestApi = urlValid && value.serviceRoleKey.trim() !== '';
  const ready = isEndpointReady(value, apiResult, dbResult);

  return (
    <Card className={cn('transition-colors', ready && 'border-[var(--ok)]/35')}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {isSource ? (
              <Cloud className="size-4 text-[var(--info)]" />
            ) : (
              <Server className="size-4 text-[var(--color-accent-500)]" />
            )}
            {isSource ? 'Source' : 'Destination'}
          </CardTitle>
          {ready && (
            <Badge tone="ok">
              <CheckCircle2 className="size-3" />
              Ready
            </Badge>
          )}
        </div>
        <CardDescription>
          {isSource ? 'The project to migrate from.' : 'The project to migrate into.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Type ---------------------------------------------------------- */}
        <div className="space-y-2">
          <Label>{isSource ? 'Source Type' : 'Destination Type'}</Label>
          <RadioGroup
            value={value.type}
            onValueChange={(next) => set('type', next as InstanceType)}
            className="grid grid-cols-2 gap-2"
          >
            {(
              [
                ['cloud', 'Supabase Cloud', Cloud],
                ['self_hosted', 'Self Hosted', Server],
              ] as const
            ).map(([type, label, Icon]) => (
              <label
                key={type}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg border p-3 text-sm transition-colors',
                  value.type === type
                    ? 'border-[var(--color-brand-500)]/50 bg-[var(--color-brand-500)]/8'
                    : 'border-[var(--line)] bg-[var(--input-bg)] hover:border-[var(--color-brand-500)]/30',
                )}
              >
                <RadioGroupItem value={type} id={`${role}-${type}`} />
                <Icon className="size-4" />
                {label}
              </label>
            ))}
          </RadioGroup>
        </div>

        {/* Supabase API --------------------------------------------------- */}
        <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--input-bg)] p-3.5">
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-[var(--fg-subtle)]" />
            <h3 className="text-sm font-medium">Supabase API</h3>
            {apiResult !== null && (
              <span className="tabular ml-auto text-xs text-[var(--fg-subtle)]">{apiResult.latencyMs}ms</span>
            )}
          </div>

          <Field
            label={isSource ? 'Source URL' : 'Destination URL'}
            htmlFor={`${role}-url`}
            required
            hint={selfHosted ? 'your API gateway' : 'https://<ref>.supabase.co'}
            error={value.url.trim() !== '' && !urlValid ? 'Enter a valid URL, including https://' : null}
          >
            <Input
              id={`${role}-url`}
              value={value.url}
              onChange={(e) => set('url', e.target.value)}
              placeholder={selfHosted ? 'https://api.example.com' : 'https://abcdefghijklmnopqrst.supabase.co'}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            {selfHosted && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--fg-subtle)]">
                The address of your Kong gateway — the one serving{' '}
                <code className="font-mono">/rest/v1</code>, <code className="font-mono">/auth/v1</code> and{' '}
                <code className="font-mono">/storage/v1</code>. Not the Studio dashboard.
              </p>
            )}
          </Field>

          <SecretField
            id={`${role}-key`}
            label="Service Role Key"
            required
            value={value.serviceRoleKey}
            onChange={(next) => set('serviceRoleKey', next)}
            placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
            error={keyInspection?.errors[0] ?? null}
            badge={
              keyInspection === null ? undefined : keyInspection.opaque ? (
                <Badge tone="brand" className="text-[10px]">
                  secret key
                </Badge>
              ) : keyInspection.role !== null ? (
                <Badge tone={keyInspection.role === 'service_role' ? 'ok' : 'danger'} className="text-[10px]">
                  {keyInspection.role}
                </Badge>
              ) : undefined
            }
          />

          {value.type === 'cloud' && (
            <SecretField
              id={`${role}-pat`}
              label="Personal Access Token"
              hint="recommended"
              value={value.accessToken}
              onChange={(next) => set('accessToken', next)}
              placeholder="sbp_…"
              help="Unlocks the Management API — the fastest way to read and write schema, and the only way to migrate Edge Functions. Create one at supabase.com/dashboard/account/tokens."
            />
          )}

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void testApiConnection()} disabled={!canTestApi} loading={testingApi}>
              <Zap />
              Test API
            </Button>
            {!canTestApi && (
              <span className="text-xs text-[var(--fg-subtle)]">A URL and service role key are required</span>
            )}
          </div>

          {apiError !== null && (
            <div className="flex gap-2.5 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/8 p-3">
              <XCircle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" />
              <p className="whitespace-pre-wrap text-xs leading-relaxed">{apiError}</p>
            </div>
          )}

          {apiResult !== null && <ApiResult result={apiResult} />}
        </section>

        {/* Database ------------------------------------------------------- */}
        <DatabasePanel
          id={role}
          value={value.database}
          onChange={setDatabase}
          result={dbResult}
          onTest={() => void testDatabaseConnection()}
          testing={testingDb}
          required={selfHosted}
          open={dbOpen}
          onOpenChange={setDbOpen}
        />

        {/* Why the endpoint is not ready yet ------------------------------ */}
        {apiResult?.ok === true && !ready && (
          <div className="flex gap-2.5 rounded-lg border border-[var(--warn)]/30 bg-[var(--warn)]/8 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" />
            <p className="text-xs leading-relaxed">
              {selfHosted
                ? 'The API is reachable, but a working PostgreSQL connection is still needed. Self-hosted Supabase has no Management API, so this is the only way to read and write the schema.'
                : 'The API is reachable, but there is no SQL channel yet. Add a Personal Access Token, or connect to the database directly.'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API result
// ---------------------------------------------------------------------------

const SERVICE_LABEL: Record<ServiceProbe['service'], string> = {
  rest: 'REST',
  auth: 'Auth',
  storage: 'Storage',
  realtime: 'Realtime',
};

function ApiResult({ result }: { result: ApiTestResult }): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--glass-bg)] p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {result.probes.map((probe) => (
          <div
            key={probe.service}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors',
              probe.ok
                ? 'border-[var(--ok)]/30 bg-[var(--ok)]/8'
                : probe.optional
                  ? 'border-[var(--warn)]/30 bg-[var(--warn)]/8'
                  : 'border-[var(--danger)]/30 bg-[var(--danger)]/8',
            )}
            title={probe.error ?? `${probe.latencyMs}ms`}
          >
            {probe.ok ? (
              <CheckCircle2 className="size-3.5 shrink-0 text-[var(--ok)]" />
            ) : (
              <XCircle
                className={cn(
                  'size-3.5 shrink-0',
                  probe.optional ? 'text-[var(--warn)]' : 'text-[var(--danger)]',
                )}
              />
            )}
            <span className="truncate font-medium">{SERVICE_LABEL[probe.service]}</span>
            {probe.ok && (
              <span className="tabular ml-auto text-[10px] text-[var(--fg-subtle)]">{probe.latencyMs}ms</span>
            )}
          </div>
        ))}
      </div>

      {result.projectRef !== null && (
        <div className="flex items-center gap-2 text-xs text-[var(--fg-subtle)]">
          <span>Project ref</span>
          <code className="font-mono text-[var(--fg-muted)]">{result.projectRef}</code>
        </div>
      )}

      {result.probes
        .filter((p) => !p.ok && p.error !== null)
        .map((probe) => (
          <div
            key={probe.service}
            className={cn(
              'flex gap-2 text-xs',
              probe.optional ? 'text-[var(--warn)]' : 'text-[var(--danger)]',
            )}
          >
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="leading-relaxed">{probe.error}</span>
          </div>
        ))}

      {result.hints.map((hint) => (
        <div key={hint} className="flex gap-2 text-xs text-[var(--fg-muted)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warn)]" />
          <span className="leading-relaxed">{hint}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function SecretField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  help,
  required,
  error,
  badge,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  help?: string;
  required?: boolean;
  error?: string | null;
  badge?: React.ReactNode;
}): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={id}>
            {label}
            {required === true && <span className="ml-0.5 text-[var(--danger)]">*</span>}
          </Label>
          {badge}
        </div>
        {hint !== undefined && <span className="text-xs text-[var(--fg-subtle)]">{hint}</span>}
      </div>

      <div className="relative">
        <Input
          id={id}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="pr-10 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--fg-subtle)] transition-colors hover:text-[var(--fg)]"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>

      {error !== undefined && error !== null && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {help !== undefined && <p className="text-xs leading-relaxed text-[var(--fg-subtle)]">{help}</p>}
    </div>
  );
}

function isValidUrl(raw: string): boolean {
  const value = raw.trim();
  if (value === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostFromUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).hostname;
  } catch {
    return null;
  }
}

export { Loader2 };
