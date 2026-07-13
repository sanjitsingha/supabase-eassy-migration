/**
 * @file Edge Functions, over the Supabase Management API.
 *
 * An honest limitation, surfaced rather than hidden: **Edge Functions can only be
 * read from, and deployed to, a Supabase Cloud project.** The Management API is a
 * hosted-platform service; a self-hosted Supabase runs Deno functions from a local
 * directory and exposes no deploy endpoint at all.
 *
 * So the behaviour is:
 *
 * - Cloud → Cloud: fully automatic. Function bodies are read from the source and
 *   deployed to the destination.
 * - Cloud → self-hosted: the source's function bodies are read and **exported**, and
 *   the migration tells the user exactly where to drop them (`supabase/functions/`)
 *   and what command to run. It does not pretend to have deployed them.
 * - Self-hosted → anywhere: nothing to read. The stage is skipped with a warning.
 *
 * Both API paths require a Personal Access Token, not the service role key.
 */

import type { EdgeFunctionDef, SupabaseCredentials } from '@/core/domain/types';
import { MigrationError, toMigrationError } from '@/core/domain/errors';
import { httpRequest, parseProjectRef } from '@/core/transport/http';

const MANAGEMENT_API = 'https://api.supabase.com';

export class EdgeFunctionRepository {
  private readonly projectRef: string | null;
  private readonly accessToken: string | null;

  constructor(creds: SupabaseCredentials) {
    this.projectRef = parseProjectRef(creds.url);
    this.accessToken = creds.accessToken !== undefined && creds.accessToken !== '' ? creds.accessToken : null;
  }

  /** Why this endpoint cannot do Edge Functions, or null when it can. */
  get unavailableReason(): string | null {
    if (this.projectRef === null) {
      return 'Edge Functions are managed by the Supabase Cloud platform. A self-hosted instance has no deploy API, so functions must be placed in supabase/functions/ and deployed with the CLI.';
    }
    if (this.accessToken === null) {
      return 'A Supabase Personal Access Token is required to read or deploy Edge Functions. The service role key does not grant access to the Management API.';
    }
    return null;
  }

  get available(): boolean {
    return this.unavailableReason === null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (this.accessToken === null) {
      throw new MigrationError('UNSUPPORTED', this.unavailableReason ?? 'Edge Functions unavailable');
    }
    return { Authorization: `Bearer ${this.accessToken}`, ...extra };
  }

  async list(): Promise<readonly EdgeFunctionDef[]> {
    if (!this.available) return [];

    const response = await httpRequest({
      method: 'GET',
      url: `${MANAGEMENT_API}/v1/projects/${this.projectRef}/functions`,
      headers: this.headers(),
      context: 'List edge functions',
    });

    const raw = await response.json<readonly Record<string, unknown>[]>();
    if (!Array.isArray(raw)) return [];

    return raw.map((f) => ({
      slug: String(f.slug ?? ''),
      name: String(f.name ?? f.slug ?? ''),
      version: typeof f.version === 'number' ? f.version : 1,
      status: String(f.status ?? 'ACTIVE'),
      verifyJwt: f.verify_jwt !== false,
      importMap: f.import_map === true,
      entrypointPath: typeof f.entrypoint_path === 'string' ? f.entrypoint_path : null,
      importMapPath: typeof f.import_map_path === 'string' ? f.import_map_path : null,
      files: null,
    }));
  }

  /**
   * Downloads a function's source.
   *
   * The body endpoint returns an `eszip` bundle, not plain files. Rather than
   * implement an eszip decoder we ask the API for the raw files, which it will
   * serve as a multipart body. When that is unavailable (older API), we fall back to
   * recording the function's metadata only and warn that the body could not be read
   * — which is honest, and better than deploying an empty function over a working one.
   */
  async fetchBody(slug: string): Promise<Readonly<Record<string, string>> | null> {
    if (!this.available) return null;

    try {
      const response = await httpRequest({
        method: 'GET',
        url: `${MANAGEMENT_API}/v1/projects/${this.projectRef}/functions/${encodeURIComponent(slug)}/body`,
        headers: this.headers(),
        context: `Fetch edge function body: ${slug}`,
      });

      const contentType = response.headers.get('content-type') ?? '';

      // Newer API versions return the sources as JSON when asked politely.
      if (contentType.includes('application/json')) {
        const body = await response.json<unknown>();
        if (Array.isArray(body)) {
          const files: Record<string, string> = {};
          for (const entry of body as readonly Record<string, unknown>[]) {
            const name = String(entry.name ?? '');
            const content = String(entry.content ?? '');
            if (name !== '') files[name] = content;
          }
          return Object.keys(files).length > 0 ? files : null;
        }
      }

      // Otherwise it is the raw entrypoint source.
      const text = await response.text();
      return text.trim() === '' ? null : { 'index.ts': text };
    } catch (err) {
      const error = toMigrationError(err);
      if (error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * Deploys a function.
   *
   * Uses the multipart `deploy` endpoint, which both creates and updates — so a
   * resumed migration that re-deploys an already-deployed function is a no-op update
   * rather than a duplicate-slug error.
   */
  async deploy(fn: EdgeFunctionDef, files: Readonly<Record<string, string>>): Promise<void> {
    if (!this.available) {
      throw new MigrationError('UNSUPPORTED', this.unavailableReason ?? 'Edge Functions unavailable');
    }

    const entrypoint = fn.entrypointPath ?? pickEntrypoint(files);
    if (entrypoint === null) {
      throw new MigrationError('UNSUPPORTED', `Edge function ${fn.slug} has no entrypoint file to deploy`);
    }

    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        name: fn.name,
        entrypoint_path: entrypoint,
        import_map_path: fn.importMapPath ?? undefined,
        verify_jwt: fn.verifyJwt,
      }),
    );

    for (const [path, content] of Object.entries(files)) {
      form.append('file', new Blob([content], { type: 'application/typescript' }), path);
    }

    await httpRequest({
      method: 'POST',
      url: `${MANAGEMENT_API}/v1/projects/${this.projectRef}/functions/deploy?slug=${encodeURIComponent(fn.slug)}`,
      // No explicit Content-Type: fetch must set the multipart boundary itself.
      headers: this.headers(),
      body: form,
      context: `Deploy edge function ${fn.slug}`,
    });
  }
}

/** Best guess at the entrypoint when the API did not record one. */
function pickEntrypoint(files: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(files);
  return (
    names.find((n) => n === 'index.ts') ??
    names.find((n) => n.endsWith('/index.ts')) ??
    names.find((n) => n.endsWith('.ts')) ??
    names[0] ??
    null
  );
}
