/**
 * @file Supabase Storage: buckets and objects.
 *
 * Objects are **streamed** source → destination. A 4 GB video is never held in
 * memory; it flows through in bounded chunks. Files at or above the multipart
 * threshold go over the resumable (TUS) protocol, which means a network drop
 * partway through a large upload resumes from the last committed offset rather
 * than restarting the whole file.
 *
 * Objects are *enumerated* over SQL rather than the Storage list API, which is a
 * deliberate trade. The list endpoint is directory-oriented: it does not recurse,
 * so a fully-nested bucket requires one request per folder, and it omits fields we
 * need. `storage.objects` is a plain Postgres table containing every object with
 * its full metadata, so one keyset-paginated scan enumerates a bucket of any depth
 * and any size. The API path is kept as a fallback for the case where no SQL
 * transport is available.
 */

import type { BucketDef, SqlTransport, StorageObjectRef, SupabaseCredentials } from '@/core/domain/types';
import { MigrationError, toMigrationError } from '@/core/domain/errors';
import { httpRequest, normaliseUrl, serviceHeaders } from '@/core/transport/http';
import { quoteLiteral } from '@/core/transport/sql';
import type { BandwidthLimiter } from '@/core/infra/concurrency';

/** A page of objects plus the cursor to continue from. */
export interface ObjectPage {
  readonly objects: readonly StorageObjectRef[];
  readonly nextCursor: string | null;
}

export class StorageRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  /** Cached: whether `storage.objects` on this instance has a `user_metadata` column. */
  private hasUserMetadata: boolean | null = null;

  constructor(
    private readonly creds: SupabaseCredentials,
    private readonly transport: SqlTransport | null,
  ) {
    this.baseUrl = `${normaliseUrl(creds.url)}/storage/v1`;
    this.headers = serviceHeaders(creds.serviceRoleKey);
  }

  // -------------------------------------------------------------------------
  // Buckets
  // -------------------------------------------------------------------------

  async listBuckets(): Promise<readonly BucketDef[]> {
    const response = await httpRequest({
      method: 'GET',
      url: `${this.baseUrl}/bucket`,
      headers: this.headers,
      context: 'List storage buckets',
    });

    const raw = await response.json<readonly Record<string, unknown>[]>();
    if (!Array.isArray(raw)) return [];

    return raw.map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? b.id ?? ''),
      public: b.public === true,
      fileSizeLimit: typeof b.file_size_limit === 'number' ? b.file_size_limit : null,
      allowedMimeTypes: Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types.map(String) : null,
      createdAt: typeof b.created_at === 'string' ? b.created_at : null,
      avifAutodetection: b.avif_autodetection === true,
    }));
  }

  /**
   * Creates a bucket, tolerating one that already exists.
   *
   * Idempotent on purpose: a resumed migration re-runs this stage, and "already
   * exists" is a success from the migration's point of view, not a failure.
   */
  async createBucket(bucket: BucketDef): Promise<'created' | 'exists'> {
    try {
      await httpRequest({
        method: 'POST',
        url: `${this.baseUrl}/bucket`,
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: bucket.id,
          name: bucket.name,
          public: bucket.public,
          file_size_limit: bucket.fileSizeLimit,
          allowed_mime_types: bucket.allowedMimeTypes,
        }),
        context: `Create bucket ${bucket.name}`,
      });
      return 'created';
    } catch (err) {
      const error = toMigrationError(err);
      // Storage returns 409 with `Duplicate` for an existing bucket.
      if (/duplicate|already exists|409/i.test(`${error.message} ${error.detail ?? ''}`)) {
        // Still reconcile visibility/limits, which may have drifted.
        await this.updateBucket(bucket).catch(() => undefined);
        return 'exists';
      }
      throw error;
    }
  }

  /** Brings an existing bucket's visibility and limits in line with the source. */
  async updateBucket(bucket: BucketDef): Promise<void> {
    await httpRequest({
      method: 'PUT',
      url: `${this.baseUrl}/bucket/${encodeURIComponent(bucket.id)}`,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public: bucket.public,
        file_size_limit: bucket.fileSizeLimit,
        allowed_mime_types: bucket.allowedMimeTypes,
      }),
      context: `Update bucket ${bucket.name}`,
    });
  }

  // -------------------------------------------------------------------------
  // Object enumeration
  // -------------------------------------------------------------------------

  /** Total objects and bytes in a bucket. Used for progress totals and validation. */
  async bucketStats(bucketId: string): Promise<{ count: number; bytes: number }> {
    if (this.transport === null) {
      // Without SQL, the only way to size a bucket is to walk it. Skip the count
      // rather than pay for a full crawl just to draw a progress bar.
      return { count: 0, bytes: 0 };
    }

    const result = await this.transport.query<{ n: unknown; bytes: unknown }>(`
      select
        count(*)::text as n,
        coalesce(sum((metadata->>'size')::bigint), 0)::text as bytes
      from storage.objects
      where bucket_id = ${quoteLiteral(bucketId)}
    `);

    const row = result.rows[0];
    return {
      count: Number.parseInt(String(row?.n ?? '0'), 10) || 0,
      bytes: Number.parseInt(String(row?.bytes ?? '0'), 10) || 0,
    };
  }

  /**
   * Pages through a bucket's objects in `name` order.
   *
   * Keyset-paginated on `name` for exactly the reasons the data copier is: OFFSET
   * over a million-object bucket is quadratic, and a name cursor is a checkpoint we
   * can resume from after a crash.
   */
  async *listObjects(bucketId: string, pageSize: number, startCursor: string | null): AsyncGenerator<ObjectPage> {
    let cursor = startCursor;

    for (;;) {
      const page =
        this.transport !== null
          ? await this.listObjectsViaSql(bucketId, pageSize, cursor)
          : await this.listObjectsViaApi(bucketId, pageSize, cursor);

      if (page.objects.length === 0) return;
      yield page;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  private async listObjectsViaSql(bucketId: string, pageSize: number, cursor: string | null): Promise<ObjectPage> {
    const transport = this.transport;
    if (transport === null) throw new MigrationError('NO_TRANSPORT', 'No SQL transport for object listing');

    await this.detectUserMetadata();
    const userMetaColumn = this.hasUserMetadata === true ? 'o.user_metadata' : 'null::jsonb';

    const where = cursor === null ? '' : `and o.name > ${quoteLiteral(cursor)}`;

    const result = await transport.query<Record<string, unknown>>(`
      select
        o.name as name,
        coalesce((o.metadata->>'size')::bigint, 0)::text as size,
        o.metadata->>'mimetype' as mime_type,
        o.metadata->>'cacheControl' as cache_control,
        o.metadata->>'eTag' as etag,
        o.updated_at::text as last_modified,
        ${userMetaColumn} as user_metadata
      from storage.objects o
      where o.bucket_id = ${quoteLiteral(bucketId)}
        ${where}
      order by o.name
      limit ${Math.max(1, Math.floor(pageSize))}
    `);

    const objects: StorageObjectRef[] = result.rows.map((r) => ({
      bucketId,
      name: String(r.name ?? ''),
      size: Number.parseInt(String(r.size ?? '0'), 10) || 0,
      mimeType: r.mime_type === null || r.mime_type === undefined ? null : String(r.mime_type),
      cacheControl: r.cache_control === null || r.cache_control === undefined ? null : String(r.cache_control),
      lastModified: r.last_modified === null || r.last_modified === undefined ? null : String(r.last_modified),
      userMetadata: parseJsonObject(r.user_metadata),
      etag: r.etag === null || r.etag === undefined ? null : String(r.etag),
    }));

    const last = objects[objects.length - 1];
    return {
      objects,
      nextCursor: objects.length < pageSize || !last ? null : last.name,
    };
  }

  /** `user_metadata` only exists on newer Storage versions; probe once and cache. */
  private async detectUserMetadata(): Promise<void> {
    if (this.hasUserMetadata !== null || this.transport === null) return;

    try {
      const result = await this.transport.query<{ ok: unknown }>(`
        select exists (
          select 1 from information_schema.columns
          where table_schema = 'storage' and table_name = 'objects' and column_name = 'user_metadata'
        ) as ok
      `);
      const value = result.rows[0]?.ok;
      this.hasUserMetadata = value === true || value === 't' || value === 'true';
    } catch {
      this.hasUserMetadata = false;
    }
  }

  /**
   * Fallback enumeration over the Storage HTTP API.
   *
   * The list endpoint is not recursive, so this walks the folder tree breadth-first
   * and flattens it. Markedly slower than the SQL path (one request per folder), and
   * only used when there is no SQL transport at all.
   */
  private async listObjectsViaApi(bucketId: string, pageSize: number, cursor: string | null): Promise<ObjectPage> {
    const collected: StorageObjectRef[] = [];
    const queue: string[] = [''];

    while (queue.length > 0 && collected.length < pageSize) {
      const prefix = queue.shift() ?? '';
      let offset = 0;

      for (;;) {
        const response = await httpRequest({
          method: 'POST',
          url: `${this.baseUrl}/object/list/${encodeURIComponent(bucketId)}`,
          headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
          context: `List objects in ${bucketId}/${prefix}`,
        });

        const entries = await response.json<readonly Record<string, unknown>[]>();
        if (!Array.isArray(entries) || entries.length === 0) break;

        for (const entry of entries) {
          const name = String(entry.name ?? '');
          const full = prefix === '' ? name : `${prefix}/${name}`;

          // The list API represents a folder as an entry with a null id.
          if (entry.id === null || entry.id === undefined) {
            queue.push(full);
            continue;
          }

          const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
          if (cursor !== null && full <= cursor) continue;

          collected.push({
            bucketId,
            name: full,
            size: typeof metadata.size === 'number' ? metadata.size : 0,
            mimeType: typeof metadata.mimetype === 'string' ? metadata.mimetype : null,
            cacheControl: typeof metadata.cacheControl === 'string' ? metadata.cacheControl : null,
            lastModified: typeof entry.updated_at === 'string' ? entry.updated_at : null,
            userMetadata: null,
            etag: typeof metadata.eTag === 'string' ? metadata.eTag : null,
          });
        }

        offset += entries.length;
        if (entries.length < 100) break;
      }
    }

    collected.sort((a, b) => a.name.localeCompare(b.name));
    const page = collected.slice(0, pageSize);
    const last = page[page.length - 1];

    return { objects: page, nextCursor: page.length < pageSize || !last ? null : last.name };
  }

  // -------------------------------------------------------------------------
  // Object transfer
  // -------------------------------------------------------------------------

  /** Opens a streaming read of an object. The caller pipes it straight to the destination. */
  async download(object: StorageObjectRef): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string; size: number }> {
    const response = await httpRequest({
      method: 'GET',
      url: `${this.baseUrl}/object/authenticated/${encodeURIComponent(object.bucketId)}/${encodePath(object.name)}`,
      headers: this.headers,
      context: `Download ${object.bucketId}/${object.name}`,
    });

    if (response.body === null) {
      throw new MigrationError('HTTP_ERROR', `Download of ${object.bucketId}/${object.name} returned an empty body`, {
        retryable: true,
      });
    }

    const contentLength = response.headers.get('content-length');
    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? object.mimeType ?? 'application/octet-stream',
      size: contentLength !== null ? Number.parseInt(contentLength, 10) || object.size : object.size,
    };
  }

  /** True when the object is already present at the destination. Enables skip-on-resume. */
  async exists(bucketId: string, name: string): Promise<boolean> {
    try {
      await httpRequest({
        method: 'HEAD',
        url: `${this.baseUrl}/object/authenticated/${encodeURIComponent(bucketId)}/${encodePath(name)}`,
        headers: this.headers,
        context: `Head ${bucketId}/${name}`,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Single-request upload, for files below the multipart threshold.
   *
   * The body is a stream, so even the "small" path does not buffer the file. Content
   * type and cache control are forwarded explicitly — dropping them is the classic
   * way a migrated bucket ends up serving every image as
   * `application/octet-stream`, which makes browsers download rather than render them.
   */
  async upload(
    object: StorageObjectRef,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    upsert: boolean,
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...this.headers,
      'Content-Type': contentType,
      'x-upsert': upsert ? 'true' : 'false',
    };
    if (object.cacheControl !== null) headers['Cache-Control'] = object.cacheControl;
    if (object.userMetadata !== null) {
      headers['x-metadata'] = Buffer.from(JSON.stringify(object.userMetadata)).toString('base64');
    }

    await httpRequest({
      method: 'POST',
      url: `${this.baseUrl}/object/${encodeURIComponent(object.bucketId)}/${encodePath(object.name)}`,
      headers,
      body,
      duplex: 'half',
      context: `Upload ${object.bucketId}/${object.name}`,
    });
  }

  /**
   * Resumable multipart upload over TUS, for large files.
   *
   * Two-step: a `POST` creates the upload and returns a URL, then each chunk is
   * `PATCH`ed at an explicit offset. Because the server tracks the offset, a chunk
   * that fails can be retried on its own — a 4 GB file that dies at 3.9 GB resumes
   * at 3.9 GB rather than starting over. Supabase requires every chunk except the
   * last to be exactly the agreed chunk size, which is why `readChunk` below fills a
   * buffer completely instead of forwarding whatever the source stream happened to
   * hand it.
   */
  async uploadResumable(
    object: StorageObjectRef,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    size: number,
    chunkSize: number,
    upsert: boolean,
    limiter?: BandwidthLimiter,
    onProgress?: (bytes: number) => void,
    signal?: () => void,
  ): Promise<void> {
    // TUS metadata is a comma-separated list of `key base64(value)` pairs.
    const metadata = [
      ['bucketName', object.bucketId],
      ['objectName', object.name],
      ['contentType', contentType],
      ...(object.cacheControl !== null ? [['cacheControl', object.cacheControl]] : []),
    ]
      .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
      .join(',');

    const createResponse = await httpRequest({
      method: 'POST',
      url: `${normaliseUrl(this.creds.url)}/storage/v1/upload/resumable`,
      headers: {
        ...this.headers,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(size),
        'Upload-Metadata': metadata,
        'x-upsert': upsert ? 'true' : 'false',
      },
      context: `Begin resumable upload ${object.bucketId}/${object.name}`,
    });

    const location = createResponse.headers.get('location');
    if (location === null) {
      throw new MigrationError(
        'HTTP_ERROR',
        `Resumable upload for ${object.name} did not return a Location header`,
        { retryable: true },
      );
    }

    const uploadUrl = location.startsWith('http') ? location : `${normaliseUrl(this.creds.url)}${location}`;
    const reader = body.getReader();
    let offset = 0;

    try {
      while (offset < size) {
        signal?.();

        const chunk = await readChunk(reader, chunkSize);
        if (chunk.length === 0) break;

        await limiter?.consume(chunk.length, signal);

        await httpRequest({
          method: 'PATCH',
          url: uploadUrl,
          headers: {
            ...this.headers,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          // A fresh Uint8Array view, because Buffer pooling means the underlying
          // ArrayBuffer may be shared and larger than the chunk.
          body: new Uint8Array(chunk),
          context: `Upload chunk at ${offset} of ${object.name}`,
        });

        offset += chunk.length;
        onProgress?.(chunk.length);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Removes an object. Used by the overwrite path when the destination refuses upsert. */
  async remove(bucketId: string, name: string): Promise<void> {
    await httpRequest({
      method: 'DELETE',
      url: `${this.baseUrl}/object/${encodeURIComponent(bucketId)}/${encodePath(name)}`,
      headers: this.headers,
      context: `Delete ${bucketId}/${name}`,
    });
  }
}

/**
 * Reads exactly `size` bytes (or fewer, at end-of-stream).
 *
 * A `ReadableStream` hands back whatever chunk size the transport felt like, which
 * for a network stream is typically 16–64 KB. TUS requires uniform chunks, so we
 * accumulate until the buffer is full. Leftovers from an over-long read are carried
 * into the next call via the pending buffer.
 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, size: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let filled = 0;

  // Carry-over from a previous read that overshot the chunk boundary.
  const carried = pending.get(reader);
  if (carried !== undefined) {
    pending.delete(reader);
    if (carried.length >= size) {
      pending.set(reader, carried.subarray(size));
      return carried.subarray(0, size);
    }
    parts.push(carried);
    filled = carried.length;
  }

  while (filled < size) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;

    if (filled + value.length > size) {
      const take = size - filled;
      parts.push(value.subarray(0, take));
      pending.set(reader, value.subarray(take));
      filled = size;
      break;
    }

    parts.push(value);
    filled += value.length;
  }

  if (parts.length === 1) return parts[0]!;

  const out = new Uint8Array(filled);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Per-reader carry-over buffers for {@link readChunk}. */
const pending = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, Uint8Array>();

/**
 * Percent-encodes each path segment but keeps the `/` separators.
 *
 * `encodeURIComponent` on the whole path would turn `a/b.png` into `a%2Fb.png`,
 * which Storage treats as a single object literally named `a/b.png` — a different
 * object in a different (non-)folder.
 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}
