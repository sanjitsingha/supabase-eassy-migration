/**
 * @file Re-enter credentials to resume a migration.
 *
 * This dialog is the visible consequence of the security model. Because service role
 * keys are held only in this process's memory and never written to disk, a server
 * restart genuinely loses them — so resuming asks for them again. That is the point,
 * not a gap: the alternative is a file on disk containing keys that grant total
 * access to two Supabase projects.
 *
 * The migration's *progress* is on disk and untouched. Supplying the keys picks up
 * from the exact row and file it stopped at.
 */

'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { KeyRound, ShieldCheck, X } from 'lucide-react';
import type { MigrationJob } from '@/core/domain/types';
import { api, ApiClientError } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui/primitives';
import { emptyEndpoint, toCredentials, type EndpointState } from '@/components/app/endpoint-form';

export function ResumeDialog({
  open,
  onOpenChange,
  job,
  onResumed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: MigrationJob;
  onResumed: () => void;
}): React.JSX.Element {
  // The URLs and instance types are already known from the persisted job — only the
  // secrets are missing. Pre-filling everything else keeps this to two fields in the
  // common case.
  const [source, setSource] = React.useState<EndpointState>(() => ({
    ...emptyEndpoint(job.source.type),
    url: job.source.url,
  }));
  const [destination, setDestination] = React.useState<EndpointState>(() => ({
    ...emptyEndpoint(job.destination.type),
    url: job.destination.url,
  }));
  const [busy, setBusy] = React.useState(false);

  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.control(job.id, 'resume', {
        source: toCredentials(source),
        destination: toCredentials(destination),
      });
      onResumed();
    } catch (err) {
      toast.error('Could not resume', {
        description: err instanceof ApiClientError ? err.message : 'Unexpected error',
      });
    } finally {
      setBusy(false);
    }
  };

  // A self-hosted endpoint has no Management API, so without a database connection
  // there is no SQL channel and the resume would fail immediately. Block it here rather
  // than letting the user press the button and watch it bounce.
  const endpointReady = (state: EndpointState, type: MigrationJob['source']['type']): boolean => {
    if (state.serviceRoleKey.trim() === '') return false;
    if (type === 'self_hosted') return (state.database.connectionString ?? '').trim() !== '';
    return true;
  };

  const ready = endpointReady(source, job.source.type) && endpointReady(destination, job.destination.type);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="glass glass-sheen fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="mb-4 flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-brand-500)]/12">
              <KeyRound className="size-4 text-[var(--info)]" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-semibold">Re-enter credentials</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm leading-relaxed text-[var(--fg-muted)]">
                Keys are held in memory only and are never written to disk, so a restart clears them.
                Your migration&apos;s progress is safe — supplying the keys again continues from the last
                checkpoint.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-4">
            <EndpointSecrets
              title="Source"
              url={job.source.url}
              state={source}
              onChange={setSource}
              needsDatabase={job.source.type === 'self_hosted'}
              isCloud={job.source.type === 'cloud'}
            />
            <EndpointSecrets
              title="Destination"
              url={job.destination.url}
              state={destination}
              onChange={setDestination}
              needsDatabase={job.destination.type === 'self_hosted'}
              isCloud={job.destination.type === 'cloud'}
            />
          </div>

          <div className="mt-5 flex items-center gap-2">
            <Button onClick={() => void resume()} disabled={!ready} loading={busy} className="flex-1">
              <ShieldCheck />
              Resume migration
            </Button>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function EndpointSecrets({
  title,
  url,
  state,
  onChange,
  needsDatabase,
  isCloud,
}: {
  title: string;
  url: string;
  state: EndpointState;
  onChange: (next: EndpointState) => void;
  needsDatabase: boolean;
  isCloud: boolean;
}): React.JSX.Element {
  const set = <K extends keyof EndpointState>(key: K, value: EndpointState[K]): void => {
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--input-bg)] p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate font-mono text-xs text-[var(--fg-subtle)]">{url}</span>
      </div>

      <Field label="Service Role Key" required>
        <Input
          type="password"
          value={state.serviceRoleKey}
          onChange={(e) => set('serviceRoleKey', e.target.value)}
          placeholder="eyJhbGciOiJIUzI1NiIs…"
          autoComplete="off"
          className="font-mono text-xs"
        />
      </Field>

      {isCloud && (
        <Field label="Personal Access Token" hint="recommended">
          <Input
            type="password"
            value={state.accessToken}
            onChange={(e) => set('accessToken', e.target.value)}
            placeholder="sbp_…"
            autoComplete="off"
            className="font-mono text-xs"
          />
        </Field>
      )}

      {/* A connection string rather than the full panel: on resume the user has
          already got a working connection, so the fastest way back to it is to paste
          the one thing that carries every field at once. */}
      <Field
        label="Postgres Connection String"
        hint={needsDatabase ? 'required' : 'optional'}
        error={
          needsDatabase && (state.database.connectionString ?? '').trim() === ''
            ? 'Self-hosted Supabase has no Management API, so this is required to continue.'
            : null
        }
      >
        <Input
          type="password"
          value={state.database.connectionString ?? ''}
          onChange={(e) =>
            set('database', { ...state.database, mode: 'connection_string', connectionString: e.target.value })
          }
          placeholder="postgresql://postgres:password@host:5432/postgres"
          autoComplete="off"
          className="font-mono text-xs"
        />
      </Field>
    </div>
  );
}
