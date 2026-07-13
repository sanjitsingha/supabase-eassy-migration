/**
 * @file Auth migration: users, identities, MFA factors, sessions.
 *
 * The spec asks to "preserve password hashes", and that requirement alone decides
 * the strategy. There are two ways to move users, and they are not equivalent:
 *
 * **SQL copy of the `auth.*` tables (preferred).** Copies `encrypted_password`
 * verbatim, keeps every user's `id` — which matters enormously, because every
 * `user_id` foreign key in the user's own `public` tables points at it — and brings
 * across identities, MFA factors and sessions, none of which the Admin API can
 * create at all. It needs a SQL transport on both ends.
 *
 * **GoTrue Admin API (fallback).** `POST /auth/v1/admin/users` accepts `password_hash`
 * and an explicit `id`, so it can preserve both. But it cannot create identities
 * (so OAuth logins break), cannot create MFA factors (so enrolled users lose 2FA),
 * and cannot create sessions (so everyone is logged out). It is used only when
 * there is no SQL transport to the destination, and the migration warns loudly.
 *
 * The SQL path deliberately intersects columns between source and destination. Two
 * Supabase instances rarely run the same GoTrue version, and the `auth.users` schema
 * changes between them — `is_anonymous` and `deleted_at` are recent additions.
 * Copying the intersection means a newer source into an older destination simply
 * drops the columns the destination has never heard of, instead of failing outright.
 */

import type { SqlTransport, StageId, SupabaseCredentials, TableDef } from '@/core/domain/types';
import { MANAGED_DATA_TABLES } from '@/core/domain/constants';
import { MigrationError, toMigrationError } from '@/core/domain/errors';
import { httpRequest, normaliseUrl, serviceHeaders } from '@/core/transport/http';
import { quoteLiteral } from '@/core/transport/sql';

/** The `auth.*` tables we copy, in dependency order (`users` before `identities`). */
export const AUTH_TABLES: readonly string[] = MANAGED_DATA_TABLES.filter(
  (t) => t.schema === 'auth' && (t.stage as StageId | 'auth') === 'auth',
).map((t) => t.table);

export interface AuthUserSummary {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly createdAt: string | null;
}

export class AuthRepository {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly creds: SupabaseCredentials,
    private readonly transport: SqlTransport | null,
  ) {
    this.baseUrl = `${normaliseUrl(creds.url)}/auth/v1`;
    this.headers = serviceHeaders(creds.serviceRoleKey);
  }

  /** Total users. Falls back to the Admin API's pagination header when there is no SQL. */
  async countUsers(): Promise<number> {
    if (this.transport !== null) {
      const result = await this.transport
        .query<{ n: unknown }>('select count(*)::text as n from auth.users')
        .catch(() => null);
      if (result !== null) return Number.parseInt(String(result.rows[0]?.n ?? '0'), 10) || 0;
    }

    try {
      const response = await httpRequest({
        method: 'GET',
        url: `${this.baseUrl}/admin/users?page=1&per_page=1`,
        headers: this.headers,
        context: 'Count auth users',
      });
      const total = response.headers.get('x-total-count');
      if (total !== null) return Number.parseInt(total, 10) || 0;

      const body = await response.json<{ users?: readonly unknown[] }>();
      return Array.isArray(body.users) ? body.users.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Which `auth.*` tables actually exist here.
   *
   * GoTrue adds and removes tables across versions (`one_time_tokens` is new;
   * `saml_relay_states` may be absent on a minimal self-host). Probing rather than
   * assuming means the migration does not fail on a table that was never there.
   */
  async existingAuthTables(): Promise<readonly string[]> {
    if (this.transport === null) return [];

    const result = await this.transport.query<{ table_name: unknown }>(`
      select c.relname as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'auth' and c.relkind = 'r'
        and c.relname in (${AUTH_TABLES.map(quoteLiteral).join(', ')})
    `);

    const found = new Set(result.rows.map((r) => String(r.table_name)));
    // Preserve dependency order rather than the catalog's arbitrary order.
    return AUTH_TABLES.filter((t) => found.has(t));
  }

  /** Reads an `auth.*` table's shape, so the copier can intersect columns. */
  async describeTable(table: string): Promise<TableDef | null> {
    if (this.transport === null) return null;

    const result = await this.transport.query<Record<string, unknown>>(`
      select
        a.attname as name,
        a.attnum::text as position,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        not a.attnotnull as is_nullable,
        a.attgenerated <> '' as is_generated
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'auth' and c.relname = ${quoteLiteral(table)}
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `);

    if (result.rows.length === 0) return null;

    const columns = result.rows.map((r) => ({
      name: String(r.name),
      position: Number.parseInt(String(r.position), 10) || 0,
      dataType: String(r.data_type),
      isNullable: r.is_nullable === true || r.is_nullable === 't',
      defaultExpr: null,
      identity: null,
      identityOptions: null,
      generatedExpr: null,
      collation: null,
      comment: null,
    }));

    const generated = result.rows
      .filter((r) => r.is_generated === true || r.is_generated === 't')
      .map((r) => String(r.name));

    // Every auth table is keyed on `id` except mfa_amr_claims, whose PK is also `id`.
    const hasId = columns.some((c) => c.name === 'id');

    return {
      schema: 'auth',
      name: table,
      kind: 'table',
      columns,
      constraints: hasId
        ? [{ name: `${table}_pkey`, kind: 'p', definition: 'PRIMARY KEY (id)', referencedTable: null, isDeferrable: false }]
        : [],
      indexes: [],
      rlsEnabled: false,
      rlsForced: false,
      comment: null,
      partitionExpr: null,
      parentTable: null,
      estimatedRows: 0,
      totalBytes: 0,
      copyKey: hasId ? ['id'] : [],
      generatedColumns: generated,
    };
  }

  // -------------------------------------------------------------------------
  // Admin API fallback
  // -------------------------------------------------------------------------

  /** Pages through users via the Admin API. Only used when SQL is unavailable. */
  async *listUsersViaApi(perPage = 200): AsyncGenerator<readonly Record<string, unknown>[]> {
    let page = 1;

    for (;;) {
      const response = await httpRequest({
        method: 'GET',
        url: `${this.baseUrl}/admin/users?page=${page}&per_page=${perPage}`,
        headers: this.headers,
        context: `List auth users (page ${page})`,
      });

      const body = await response.json<{ users?: readonly Record<string, unknown>[] }>();
      const users = Array.isArray(body.users) ? body.users : [];
      if (users.length === 0) return;

      yield users;
      if (users.length < perPage) return;
      page += 1;
    }
  }

  /**
   * Creates a user via the Admin API, preserving id, password hash and confirmations.
   *
   * `password_hash` is passed straight through, so the user's existing password keeps
   * working — GoTrue stores it as-is rather than re-hashing. What this path *cannot*
   * carry is identities, MFA and sessions; the caller warns about that.
   */
  async createUserViaApi(user: Record<string, unknown>): Promise<'created' | 'exists'> {
    const payload: Record<string, unknown> = {
      id: user.id,
      email: user.email,
      phone: user.phone,
      password_hash: user.encrypted_password,
      email_confirm: user.email_confirmed_at !== null && user.email_confirmed_at !== undefined,
      phone_confirm: user.phone_confirmed_at !== null && user.phone_confirmed_at !== undefined,
      user_metadata: user.raw_user_meta_data ?? {},
      app_metadata: user.raw_app_meta_data ?? {},
      ban_duration: user.banned_until !== null && user.banned_until !== undefined ? 'none' : undefined,
    };

    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }

    try {
      await httpRequest({
        method: 'POST',
        url: `${this.baseUrl}/admin/users`,
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        context: `Create auth user ${String(user.email ?? user.id)}`,
      });
      return 'created';
    } catch (err) {
      const error = toMigrationError(err);
      if (/already (been )?registered|duplicate|already exists/i.test(`${error.message} ${error.detail ?? ''}`)) {
        return 'exists';
      }
      throw error;
    }
  }

  /** Whether this endpoint can do a full-fidelity auth migration. */
  get canUseSql(): boolean {
    return this.transport !== null;
  }

  /** Sanity-checks that the auth service is reachable and the key is a service role key. */
  async health(): Promise<boolean> {
    try {
      await httpRequest({
        method: 'GET',
        url: `${this.baseUrl}/admin/users?page=1&per_page=1`,
        headers: this.headers,
        context: 'Auth health check',
      });
      return true;
    } catch (err) {
      const error = toMigrationError(err);
      if (error.code === 'AUTH_FAILED') {
        throw new MigrationError(
          'AUTH_FAILED',
          'The Auth API rejected this key. A service role key (not the anon key) is required.',
          { detail: error.detail },
        );
      }
      return false;
    }
  }
}
