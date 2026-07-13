/**
 * @file Step 1: the combined connection test.
 *
 * Runs the five steps — REST, Auth, Storage, Realtime, then the database — and works
 * out which SQL transport we will actually get. That last part is the one that decides
 * whether a migration is possible at all: a project that answers on REST but offers no
 * SQL channel cannot have its schema read, and it is far kinder to say so here than to
 * fail three minutes into Step 4.
 *
 * The individual `testApi` / `testDatabase` calls are exposed separately (and used
 * directly by the two buttons in the form) because on a self-hosted deployment they
 * fail for entirely unrelated reasons. This function composes them; it does not
 * re-implement them.
 */

import type {
  ConnectionTestResult,
  EndpointRole,
  SupabaseCredentials,
  TransportCapability,
  TransportKind,
} from '@/core/domain/types';
import { toMigrationError } from '@/core/domain/errors';
import { normaliseUrl, parseProjectRef } from '@/core/transport/http';
import { probeTransports } from '@/core/transport/transports';
import { testApi, testDatabase } from '@/core/services/diagnostics.service';

/** Preference order — must match the factory's, or the UI would advertise the wrong one. */
const PREFERENCE: readonly TransportKind[] = ['management_api', 'postgres', 'rpc'];

export async function testConnection(
  creds: SupabaseCredentials,
  role: EndpointRole,
): Promise<ConnectionTestResult> {
  const started = Date.now();
  const url = normaliseUrl(creds.url);
  const projectRef = parseProjectRef(url);

  const errors: string[] = [];
  const warnings: string[] = [];

  // A Cloud URL declared as self-hosted (or the reverse) is a very common paste error
  // and it silently disables the Management API. Catch it here rather than letting the
  // user wonder why the fast transport never appears.
  if (creds.type === 'cloud' && projectRef === null) {
    warnings.push(
      'This does not look like a Supabase Cloud URL (https://<ref>.supabase.co). Management API features, including Edge Functions, will be unavailable.',
    );
  }
  if (creds.type === 'self_hosted' && projectRef !== null) {
    warnings.push('This is a Supabase Cloud URL but the type is set to Self Hosted. Consider switching the type.');
  }

  const hasDatabaseConfig =
    creds.database !== undefined || (creds.dbPassword !== undefined && creds.dbPassword !== '');

  // The API probes and the SQL transport probes are independent; run them together.
  const [api, database, probes] = await Promise.all([
    testApi(creds),
    hasDatabaseConfig ? testDatabase(creds) : Promise.resolve(null),
    probeTransports(creds).catch(() => []),
  ]);

  const transports: TransportCapability[] = probes.map((p) => ({
    kind: p.kind,
    available: p.available,
    reason: p.reason,
  }));

  // The probes opened real connections. Release them now that we know what works.
  await Promise.all(probes.map((p) => p.transport?.dispose() ?? Promise.resolve()));

  const selectedTransport =
    PREFERENCE.find((kind) => transports.some((t) => t.kind === kind && t.available)) ?? null;

  // --- What is actually wrong ------------------------------------------------
  for (const error of api.key.errors) errors.push(error);
  for (const warning of api.key.warnings) warnings.push(warning);

  const failedRequired = api.probes.filter((p) => !p.ok && !p.optional);
  if (failedRequired.length > 0) {
    errors.push(
      `Supabase services did not respond: ${failedRequired.map((p) => p.service.toUpperCase()).join(', ')}. Check the URL points at your API gateway.`,
    );
  }

  if (selectedTransport === null) {
    if (creds.type === 'self_hosted') {
      errors.push(
        database?.error ??
          'No database connection is configured. A self-hosted Supabase has no Management API, so a direct Postgres connection is the only way to read and write its schema.',
      );
    } else {
      errors.push(
        'No SQL transport is available, so the schema cannot be read or written. Supply a Personal Access Token or a database password.',
      );
    }
  }

  if (selectedTransport === 'rpc') {
    warnings.push(
      'Falling back to the SQL helper function (RPC). It works, but a direct database connection is faster and needs nothing installed.',
    );
  }

  if (api.probes.find((p) => p.service === 'realtime')?.ok === false) {
    warnings.push('Realtime did not respond. Every stage except the Realtime publication will still run.');
  }

  if (database !== null && database.ok) {
    const blocking = database.permissions.find((p) => p.key === 'create_table' && !p.granted);
    if (blocking !== undefined && role === 'destination') {
      errors.push(
        `The database user "${database.user ?? 'unknown'}" cannot create tables. A migration into this destination would fail.`,
      );
    }
    for (const permission of database.permissions) {
      if (!permission.granted && permission.key !== 'superuser' && permission.key !== 'create_table') {
        warnings.push(`${permission.label}: not granted. ${permission.required}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    role,
    instanceType: creds.type,
    projectRef: projectRef ?? safeHost(url),
    api,
    database,
    transports,
    selectedTransport,
    latencyMs: Date.now() - started,
    errors,
    warnings,
  };
}

/** Re-exported so the API routes can drive the two buttons independently. */
export { testApi, testDatabase };

/**
 * Guesses a database host from the API URL.
 *
 * Used by auto-detection: after the API test passes we try Postgres on the same host,
 * which is right for a plain Docker Compose deployment where Kong and Postgres share a
 * machine. When it is wrong — and behind a reverse proxy, on Coolify, or on Kubernetes
 * it usually is — the user gets the Database Connection panel and fills it in. The
 * guess costs one TCP timeout and saves the common case entirely.
 */
export function guessDatabaseHost(url: string): string | null {
  try {
    return new URL(normaliseUrl(url)).hostname;
  } catch {
    return null;
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Kept for callers that only need to know whether an endpoint is usable at all. */
export function summariseFailure(err: unknown): string {
  return toMigrationError(err).message;
}
