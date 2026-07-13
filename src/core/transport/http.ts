/**
 * @file Shared HTTP client for every Supabase API surface.
 *
 * Adds the three things `fetch` alone does not give us and that a long-running
 * migration cannot do without: a hard per-request timeout (a hung socket must not
 * wedge a stage forever), consistent error classification, and honouring
 * `Retry-After` so we back off by exactly as long as the server asked.
 */

import { fromHttpStatus, MigrationError, toMigrationError } from '@/core/domain/errors';
import { DEFAULTS } from '@/core/domain/constants';

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
  readonly timeoutMs?: number;
  readonly context: string;
  /** Pass through a streaming request body (required by undici for `ReadableStream`). */
  readonly duplex?: 'half';
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

/** Performs a request, throwing a classified {@link MigrationError} on non-2xx. */
export async function httpRequest(request: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? DEFAULTS.requestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      // `duplex: 'half'` is mandatory when the body is a stream. It is not in the
      // DOM lib types yet, hence the cast.
      ...(request.duplex ? { duplex: request.duplex } : {}),
    } as RequestInit);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MigrationError('TIMEOUT', `${request.context}: timed out after ${timeoutMs}ms`, { retryable: true });
    }
    throw toMigrationError(err, `${request.context}: request failed`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Read at most 4 KB of the error body: a failing storage endpoint can return
    // a very large HTML page, and we only want it for the log line.
    const body = await readCapped(response, 4096);
    const error = fromHttpStatus(response.status, body, request.context);

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null && error.retryable) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        throw new MigrationError(error.code, `${error.message} (retry after ${seconds}s)`, {
          retryable: true,
          detail: error.detail,
        });
      }
    }
    throw error;
  }

  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
  };
}

async function readCapped(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '';
  }
}

/** Normalises a user-supplied project URL: trims whitespace and any trailing slash. */
export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Extracts the project ref from a Supabase Cloud URL.
 *
 * `https://abcdefghijklmnop.supabase.co` -> `abcdefghijklmnop`. Returns null for
 * self-hosted URLs, which have no ref — the caller must then avoid every
 * Management API code path.
 */
export function parseProjectRef(url: string): string | null {
  try {
    const { hostname } = new URL(normaliseUrl(url));
    const match = /^([a-z0-9]{20})\.supabase\.(co|in|red)$/i.exec(hostname);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** Standard headers for PostgREST / Auth / Storage calls with the service role key. */
export function serviceHeaders(serviceRoleKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}
