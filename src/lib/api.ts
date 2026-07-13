/**
 * @file Typed client for the application's own API.
 *
 * Every call funnels through {@link request}, which turns a non-2xx response into a
 * thrown {@link ApiClientError} carrying the server's own error code. The code is
 * what the UI branches on — most importantly `CREDENTIALS_EXPIRED`, which is the
 * signal to re-prompt for keys before resuming a job.
 */

import type {
  ApiTestResult,
  ConnectionTestResult,
  DatabaseTestResult,
  DiscoveryReport,
  EndpointRole,
  LogEntry,
  MigrationJob,
  MigrationOptions,
  StageSelection,
  SupabaseCredentials,
} from '@/core/domain/types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code = 'HTTP_ERROR';
    let detail: string | undefined;

    try {
      const body = (await response.json()) as { error?: string; code?: string; detail?: string };
      message = body.error ?? message;
      code = body.code ?? code;
      detail = body.detail;
    } catch {
      // Not JSON — keep the generic message rather than crashing on the parse.
    }

    throw new ApiClientError(message, code, response.status, detail);
  }

  return response.json() as Promise<T>;
}

/** A migration as the detail endpoint returns it, with the two process-local flags. */
export type MigrationJobDetail = MigrationJob & {
  readonly isRunning: boolean;
  readonly hasCredentials: boolean;
};

export const api = {
  /** Steps 1–4: REST, Auth, Storage, Realtime. */
  testApi(credentials: SupabaseCredentials): Promise<ApiTestResult> {
    return request<ApiTestResult>('/api/connections/test-api', {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    });
  },

  /**
   * Step 5: Postgres.
   *
   * Resolves even when the connection fails — the diagnostic *is* the payload. Only a
   * malformed request rejects.
   */
  testDatabase(credentials: SupabaseCredentials): Promise<DatabaseTestResult> {
    return request<DatabaseTestResult>('/api/connections/test-database', {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    });
  },

  /** All five steps, plus transport selection. Used to gate the wizard. */
  testConnection(credentials: SupabaseCredentials, role: EndpointRole): Promise<ConnectionTestResult> {
    return request<ConnectionTestResult>('/api/connections/test', {
      method: 'POST',
      body: JSON.stringify({ credentials, role }),
    });
  },

  discover(credentials: SupabaseCredentials): Promise<DiscoveryReport> {
    return request<DiscoveryReport>('/api/discovery', {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    });
  },

  listMigrations(): Promise<readonly MigrationJob[]> {
    return request<readonly MigrationJob[]>('/api/migrations');
  },

  getMigration(id: string): Promise<MigrationJobDetail> {
    return request<MigrationJobDetail>(`/api/migrations/${id}`);
  },

  createMigration(input: {
    name: string;
    source: SupabaseCredentials;
    destination: SupabaseCredentials;
    selection: StageSelection;
    options?: Partial<MigrationOptions>;
  }): Promise<MigrationJob> {
    return request<MigrationJob>('/api/migrations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  deleteMigration(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/migrations/${id}`, { method: 'DELETE' });
  },

  /**
   * Drives start/pause/resume/cancel.
   *
   * `credentials` is only sent on a resume whose vault entry has expired — the server
   * answers `409 CREDENTIALS_EXPIRED`, the UI collects the keys, and calls back.
   */
  control(
    id: string,
    action: 'start' | 'pause' | 'resume' | 'cancel',
    credentials?: { source: SupabaseCredentials; destination: SupabaseCredentials },
  ): Promise<{ ok: boolean; status: string }> {
    return request<{ ok: boolean; status: string }>(`/api/migrations/${id}/control`, {
      method: 'POST',
      body: JSON.stringify({ action, ...(credentials ? { credentials } : {}) }),
    });
  },

  getLogs(
    id: string,
    params: { search?: string; levels?: readonly string[]; limit?: number } = {},
  ): Promise<{ entries: readonly LogEntry[]; total: number }> {
    const query = new URLSearchParams();
    if (params.search !== undefined && params.search !== '') query.set('search', params.search);
    if (params.levels !== undefined && params.levels.length > 0) query.set('levels', params.levels.join(','));
    if (params.limit !== undefined) query.set('limit', String(params.limit));

    return request<{ entries: readonly LogEntry[]; total: number }>(`/api/migrations/${id}/logs?${query}`);
  },

  getAllLogs(
    params: { search?: string; levels?: readonly string[]; limit?: number } = {},
  ): Promise<{ entries: readonly LogEntry[]; total: number }> {
    const query = new URLSearchParams();
    if (params.search !== undefined && params.search !== '') query.set('search', params.search);
    if (params.levels !== undefined && params.levels.length > 0) query.set('levels', params.levels.join(','));
    if (params.limit !== undefined) query.set('limit', String(params.limit));

    return request<{ entries: readonly LogEntry[]; total: number }>(`/api/logs?${query}`);
  },

  getSettings(): Promise<SettingsPayload> {
    return request<SettingsPayload>('/api/settings');
  },

  clearVault(): Promise<{ ok: boolean; cleared: number }> {
    return request<{ ok: boolean; cleared: number }>('/api/settings', { method: 'DELETE' });
  },
} as const;

export interface SettingsPayload {
  readonly defaults: Readonly<Record<string, number>>;
  readonly vault: {
    readonly entries: readonly { readonly jobId: string; readonly role: string; readonly expiresInMs: number }[];
    readonly ttlMs: number;
  };
  readonly store: { readonly jobs: number; readonly logs: number; readonly bytes: number; readonly directory: string };
  readonly running: readonly string[];
  readonly helperSql: { readonly install: string; readonly drop: string };
}
