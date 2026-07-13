/**
 * @file Settings — defaults, credential vault state, local store, and the SQL helper.
 */

'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Check, Copy, Database, HardDrive, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type SettingsPayload } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/shell';

export default function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = React.useState<SettingsPayload | null>(null);
  const [clearing, setClearing] = React.useState(false);

  // See the note in the history page: bumping this is how an action outside the effect
  // requests a re-fetch, keeping every `setState` behind an `await` inside the effect.
  const [refreshKey, setRefreshKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const result = await api.getSettings();
        if (!cancelled) setSettings(result);
      } catch {
        if (!cancelled) setSettings(null);
      }
    };

    void load();
    // The vault expiry countdown is live, so keep it fresh.
    const timer = setInterval(() => void load(), 10_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey]);

  const clearVault = async (): Promise<void> => {
    if (!window.confirm('Wipe every credential held in memory? Any running migration will pause and ask for keys again.')) {
      return;
    }
    setClearing(true);
    try {
      const result = await api.clearVault();
      toast.success(`Cleared ${result.cleared} credential entr${result.cleared === 1 ? 'y' : 'ies'}`);
      setRefreshKey((k) => k + 1);
    } catch {
      toast.error('Could not clear the vault');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" description="Defaults, security posture, and local storage." />

      <div className="space-y-4">
        {/* Security ---------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-[var(--ok)]" />
              Credential security
            </CardTitle>
            <CardDescription>How service role keys are handled while a migration runs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2 text-sm">
              {[
                'Keys, passwords and access tokens are held only in this process’s memory. Nothing is written to disk, ever.',
                'At rest in memory they are AES-256-GCM encrypted under a key generated fresh at every process start, so a heap dump from yesterday cannot be decrypted today.',
                'Entries expire and are zeroed automatically. Restarting the server clears them immediately, which is why resuming a migration asks for the keys again.',
                'The persisted migration record holds only the URL, project ref and transport — never a secret.',
              ].map((line) => (
                <li key={line} className="flex gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" />
                  <span className="leading-relaxed text-[var(--fg-muted)]">{line}</span>
                </li>
              ))}
            </ul>

            <Separator />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="size-4 text-[var(--fg-subtle)]" />
                  In memory now
                  <Badge tone={(settings?.vault.entries.length ?? 0) > 0 ? 'warn' : 'ok'}>
                    {settings?.vault.entries.length ?? 0} entr
                    {(settings?.vault.entries.length ?? 0) === 1 ? 'y' : 'ies'}
                  </Badge>
                </div>
                {settings !== null && settings.vault.entries.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {settings.vault.entries.map((entry) => (
                      <div key={`${entry.jobId}-${entry.role}`} className="font-mono text-xs text-[var(--fg-subtle)]">
                        {entry.jobId} · {entry.role} · expires in {formatDuration(entry.expiresInMs)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Button
                variant="danger"
                onClick={() => void clearVault()}
                loading={clearing}
                disabled={(settings?.vault.entries.length ?? 0) === 0}
              >
                <Trash2 />
                Clear all credentials
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Defaults ---------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Migration defaults</CardTitle>
            <CardDescription>
              Applied to new migrations. Tune these for very large databases or constrained networks.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings === null ? (
              <div className="h-32 animate-pulse rounded-lg bg-[var(--line)]" />
            ) : (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {[
                  ['Batch size', formatNumber(settings.defaults.batchSize ?? 0), 'rows per round-trip'],
                  ['Table concurrency', String(settings.defaults.tableConcurrency ?? 0), 'tables copied in parallel'],
                  ['Storage concurrency', String(settings.defaults.storageConcurrency ?? 0), 'files uploaded in parallel'],
                  ['Max retries', String(settings.defaults.maxRetries ?? 0), 'attempts before a task is failed'],
                  [
                    'Multipart threshold',
                    formatBytes(settings.defaults.multipartThresholdBytes ?? 0),
                    'files above this use resumable upload',
                  ],
                  [
                    'Bandwidth limit',
                    (settings.defaults.bandwidthLimitBytesPerSec ?? 0) === 0
                      ? 'Unlimited'
                      : `${formatBytes(settings.defaults.bandwidthLimitBytesPerSec ?? 0)}/s`,
                    'throttles storage transfer',
                  ],
                ].map(([label, value, hint]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] pb-2">
                    <div>
                      <dt className="text-sm">{label}</dt>
                      <dd className="text-xs text-[var(--fg-subtle)]">{hint}</dd>
                    </div>
                    <span className="tabular shrink-0 text-sm font-medium">{value}</span>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* SQL helper -------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-[var(--info)]" />
              SQL helper function
            </CardTitle>
            <CardDescription>
              Only needed when an instance has neither a Personal Access Token (Cloud) nor a reachable
              Postgres port. Run this in the project&apos;s SQL editor to unlock the RPC transport, then drop it
              once the migration is done — it grants full database access to the service role.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {settings === null ? (
              <div className="h-40 animate-pulse rounded-lg bg-[var(--line)]" />
            ) : (
              <>
                <SqlBlock title="Install" sql={settings.helperSql.install} />
                <SqlBlock title="Remove when finished" sql={settings.helperSql.drop} />
              </>
            )}
          </CardContent>
        </Card>

        {/* Local store ------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-[var(--fg-subtle)]" />
              Local store
            </CardTitle>
            <CardDescription>
              Migration state and logs are kept on this machine so a job survives a restart and can be
              resumed from its last checkpoint.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings === null ? (
              <div className="h-16 animate-pulse rounded-lg bg-[var(--line)]" />
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between border-b border-[var(--line)] pb-2">
                  <span className="text-[var(--fg-muted)]">Migrations stored</span>
                  <span className="tabular font-medium">{formatNumber(settings.store.jobs)}</span>
                </div>
                <div className="flex justify-between border-b border-[var(--line)] pb-2">
                  <span className="text-[var(--fg-muted)]">Log files</span>
                  <span className="tabular font-medium">{formatNumber(settings.store.logs)}</span>
                </div>
                <div className="flex justify-between border-b border-[var(--line)] pb-2">
                  <span className="text-[var(--fg-muted)]">Disk used</span>
                  <span className="tabular font-medium">{formatBytes(settings.store.bytes)}</span>
                </div>
                <div className="flex flex-wrap justify-between gap-2 pt-1">
                  <span className="text-[var(--fg-muted)]">Location</span>
                  <span className="break-all font-mono text-xs text-[var(--fg-subtle)]">
                    {settings.store.directory}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SqlBlock({ title, sql }: { title: string; sql: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-[var(--fg-subtle)]">{title}</span>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="scrollbar-thin max-h-56 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--input-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--fg-muted)]">
        {sql}
      </pre>
    </div>
  );
}
