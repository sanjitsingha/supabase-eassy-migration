/**
 * @file Connection diagnostics for the Step 1 test buttons.
 *
 * Split into two independent tests because on a self-hosted deployment they fail for
 * completely unrelated reasons, and a single combined "Test Connection" that says
 * "failed" is useless. The API lives behind Kong on 443; Postgres lives on 5432,
 * often on a *different* host, frequently on an internal network the API gateway
 * cannot even see. A user whose API works and whose database does not needs to know
 * exactly that.
 *
 * The other job here is turning Postgres's error codes into instructions. `ENOIDENTIFIER`
 * is the worst offender — it means "you connected to Supavisor with a username that has
 * no tenant in it", which is not a thing any error message says, and it is the single
 * most common self-hosted misconfiguration. So we detect it and say what to do.
 */

import { Client } from 'pg';
import type {
  ApiTestResult,
  DatabaseConnection,
  DatabasePermission,
  DatabaseTestResult,
  ServiceProbe,
  SupabaseCredentials,
  SupabaseService,
} from '@/core/domain/types';
import { toMigrationError } from '@/core/domain/errors';
import { httpRequest, normaliseUrl, parseProjectRef, serviceHeaders } from '@/core/transport/http';
import { inspectKey } from '@/core/transport/jwt';
import { detectPooler, resolveConnection } from '@/core/transport/postgres-url';
import { buildPostgresConfig } from '@/core/transport/transports';

// ---------------------------------------------------------------------------
// API test — steps 1 to 4
// ---------------------------------------------------------------------------

interface ProbeSpec {
  readonly service: SupabaseService;
  readonly path: string;
  readonly optional: boolean;
}

const PROBES: readonly ProbeSpec[] = [
  { service: 'rest', path: '/rest/v1/', optional: false },
  { service: 'auth', path: '/auth/v1/settings', optional: false },
  { service: 'storage', path: '/storage/v1/bucket', optional: false },
  // Realtime is not needed to migrate schema, data, storage or auth — only to
  // reinstate the publication, which degrades to a warning.
  { service: 'realtime', path: '/realtime/v1/api/tenants/realtime-dev/health', optional: true },
];

export async function testApi(creds: SupabaseCredentials): Promise<ApiTestResult> {
  const started = Date.now();
  const url = normaliseUrl(creds.url);
  const key = inspectKey(creds.serviceRoleKey);
  const headers = serviceHeaders(creds.serviceRoleKey);
  const hints: string[] = [];

  // All four concurrently: one slow service must not serialise behind the others.
  const probes = await Promise.all(
    PROBES.map(async (spec): Promise<ServiceProbe> => {
      const probeStarted = Date.now();
      try {
        const response = await httpRequest({
          method: 'GET',
          url: `${url}${spec.path}`,
          headers,
          context: `${spec.service} probe`,
          timeoutMs: 15_000,
        });
        return {
          service: spec.service,
          ok: true,
          status: response.status,
          latencyMs: Date.now() - probeStarted,
          error: null,
          optional: spec.optional,
        };
      } catch (err) {
        const error = toMigrationError(err);

        // A 404 still proves the service answered *and* accepted our key — it simply
        // has nothing at that path. Only auth and network failures mean "not there".
        // (Storage with zero buckets, and some Auth builds, legitimately 404 here.)
        const reachable = error.code === 'NOT_FOUND';

        return {
          service: spec.service,
          ok: reachable,
          status: reachable ? 404 : null,
          latencyMs: Date.now() - probeStarted,
          error: reachable ? null : describeApiError(spec.service, error.code, error.message),
          optional: spec.optional,
        };
      }
    }),
  );

  const failedRequired = probes.filter((p) => !p.ok && !p.optional);
  const realtime = probes.find((p) => p.service === 'realtime');

  if (failedRequired.some((p) => p.error?.includes('unauthorized') === true)) {
    hints.push('The key was rejected. Confirm you copied the service role key, not the anon key.');
  }
  if (failedRequired.length === probes.filter((p) => !p.optional).length) {
    hints.push(
      'No Supabase service answered. Check the URL points at your API gateway (Kong), not at the Studio dashboard or the database.',
    );
  } else if (failedRequired.length > 0) {
    hints.push(
      `Some services are unreachable (${failedRequired.map((p) => p.service).join(', ')}). Your reverse proxy may not be routing every path — Kong must expose /rest/v1, /auth/v1, /storage/v1 and /realtime/v1.`,
    );
  }
  if (realtime?.ok === false) {
    hints.push('Realtime did not respond. The migration will still run; only the Realtime publication step is affected.');
  }

  return {
    ok: failedRequired.length === 0 && key.errors.length === 0,
    url,
    projectRef: parseProjectRef(url),
    probes,
    key,
    latencyMs: Date.now() - started,
    hints,
  };
}

function describeApiError(service: SupabaseService, code: string, message: string): string {
  switch (code) {
    case 'AUTH_FAILED':
      return `${service} rejected the key (unauthorized).`;
    case 'CONNECTION_FAILED':
      return `Could not reach ${service}. The host may be wrong, or unreachable from this machine.`;
    case 'TIMEOUT':
      return `${service} timed out. It may be down, or blocked by a firewall.`;
    default:
      return message;
  }
}

// ---------------------------------------------------------------------------
// Database test — step 5
// ---------------------------------------------------------------------------

/**
 * The permissions that actually decide whether a migration can succeed.
 *
 * Checked with `has_*_privilege` rather than inferred from `rolsuper`, because a
 * correctly-locked-down deployment can grant exactly these without handing out
 * superuser — and we should not tell such a user they are misconfigured.
 */
const PERMISSION_SQL = `
  select
    has_database_privilege(current_user, current_database(), 'CREATE') as create_schema,
    has_schema_privilege(current_user, 'public', 'CREATE')             as create_table,
    (select rolsuper       from pg_roles where rolname = current_user) as superuser,
    (select rolcreatedb    from pg_roles where rolname = current_user) as createdb,
    (select rolreplication from pg_roles where rolname = current_user) as replication,
    -- Must be a lookup, not pg_has_role(current_user, 'supabase_admin', 'MEMBER').
    -- pg_has_role RAISES when the named role does not exist, and plenty of the
    -- deployments this tool targets have no supabase_admin at all — a bare Postgres
    -- destination, or a hardened self-host that renamed it. The raise would abort the
    -- whole permission query and surface as a bogus "role does not exist" error about
    -- the user's own login. Selecting the OID first yields NULL instead.
    coalesce(
      (select pg_has_role(current_user, r.oid, 'MEMBER')
       from pg_roles r where r.rolname = 'supabase_admin'),
      false
    ) as supabase_admin
`;

export async function testDatabase(creds: SupabaseCredentials): Promise<DatabaseTestResult> {
  const started = Date.now();

  const empty = (error: string, errorCode: string | null, hints: string[]): DatabaseTestResult => ({
    ok: false,
    version: null,
    versionFull: null,
    database: null,
    user: null,
    permissions: [],
    extensions: [],
    resolved: creds.database ? resolveConnection(creds.database) : null,
    pooler: creds.database ? poolerFor(creds.database) : null,
    error,
    errorCode,
    hints,
    latencyMs: Date.now() - started,
  });

  const config = buildPostgresConfig(creds);
  if (config === null) {
    return empty('No database connection is configured.', 'NOT_CONFIGURED', [
      'Enter a Postgres connection string, or the host, port, database, username and password.',
    ]);
  }

  const resolved = creds.database ? resolveConnection(creds.database) : null;
  const pooler = creds.database ? poolerFor(creds.database) : null;

  const client = new Client(config);

  try {
    await client.connect();

    const [versionRow, identityRow, permissionRow, extensionRows] = await Promise.all([
      client.query<{ version: string }>('select version() as version'),
      client.query<{ db: string; usr: string }>('select current_database() as db, current_user as usr'),
      client.query<Record<string, boolean | null>>(PERMISSION_SQL),
      client.query<{ name: string; version: string }>(
        `select extname as name, extversion as version from pg_extension order by extname`,
      ),
    ]);

    const versionFull = versionRow.rows[0]?.version ?? '';
    const perms = permissionRow.rows[0] ?? {};

    const superuser = perms.superuser === true;
    const supabaseAdmin = perms.supabase_admin === true;

    const permissions: DatabasePermission[] = [
      {
        key: 'create_schema',
        label: 'Create schemas',
        granted: perms.create_schema === true,
        required: 'Needed to recreate custom schemas. Without it, only existing schemas can be migrated into.',
      },
      {
        key: 'create_table',
        label: 'Create tables',
        granted: perms.create_table === true,
        required: 'Needed for every table, view, function and policy. A migration cannot proceed without it.',
      },
      {
        key: 'create_extension',
        label: 'Install extensions',
        granted: superuser || supabaseAdmin || perms.createdb === true,
        required: 'Needed for the Extensions stage. Deselect it in Step 3 if your destination already has them.',
      },
      {
        key: 'replication',
        label: 'Manage publications',
        granted: superuser || supabaseAdmin || perms.replication === true,
        required: 'Needed to enable Realtime on the destination. Other stages are unaffected.',
      },
      {
        key: 'superuser',
        label: 'Superuser',
        granted: superuser,
        required: 'Not required. Shown for reference — a non-superuser with the grants above can migrate fine.',
      },
    ];

    const hints: string[] = [];
    if (!permissions[1]!.granted) {
      hints.push(
        `The user "${identityRow.rows[0]?.usr ?? 'unknown'}" cannot create tables in the public schema. Connect as postgres, or grant it CREATE on the database.`,
      );
    }
    if (pooler === 'supavisor' && creds.database?.poolerMode === 'direct') {
      hints.push(
        'This looks like a Supavisor pooler but the mode is set to Direct. If statements start failing, switch the pooler mode to Transaction.',
      );
    }

    return {
      ok: true,
      version: shortVersion(versionFull),
      versionFull,
      database: identityRow.rows[0]?.db ?? null,
      user: identityRow.rows[0]?.usr ?? null,
      permissions,
      extensions: extensionRows.rows.map((r) => ({ name: r.name, version: r.version })),
      resolved,
      pooler,
      error: null,
      errorCode: null,
      hints,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const { message, code, hints } = describeDatabaseError(err, creds.database, resolved);
    return {
      ...empty(message, code, hints),
      resolved,
      pooler: pooler ?? (isTenantError(err) ? 'supavisor' : null),
      latencyMs: Date.now() - started,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function poolerFor(connection: DatabaseConnection): 'supavisor' | 'pgbouncer' | null {
  const resolved = resolveConnection(connection);
  return resolved === null ? null : detectPooler(resolved);
}

/** `PostgreSQL 17.6 (Ubuntu…) on x86_64…` → `17.6`. */
function shortVersion(raw: string): string | null {
  const match = /PostgreSQL (\d+(?:\.\d+)*)/.exec(raw);
  return match?.[1] ?? null;
}

function isTenantError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err);
  return /ENOIDENTIFIER|no tenant identifier|tenant not found/i.test(text);
}

/**
 * Turns a Postgres/socket failure into a message and a set of next steps.
 *
 * Each branch answers the question the user is actually asking, which is never "what
 * is the error code" but "what do I change".
 */
function describeDatabaseError(
  err: unknown,
  connection: DatabaseConnection | undefined,
  resolved: { host: string; port: number; username: string; database: string } | null,
): { message: string; code: string | null; hints: string[] } {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = typeof (err as { code?: unknown }).code === 'string' ? ((err as { code: string }).code) : null;
  const text = error.message;

  // --- Supavisor: the headline case -----------------------------------------
  if (isTenantError(err)) {
    return {
      message: 'Supavisor rejected the connection: no tenant identifier.',
      code: 'ENOIDENTIFIER',
      hints: [
        'You are connected to Supavisor (Supabase’s connection pooler), which needs the project encoded in the username.',
        resolved !== null
          ? `Either change the username from "${resolved.username}" to "${resolved.username}.<your-project-ref>", or bypass the pooler entirely.`
          : 'Either qualify the username with your project ref, or bypass the pooler entirely.',
        'Bypassing is usually the better answer for a migration. Use Direct PostgreSQL on port 5432 instead of the pooler on 6543.',
        'On Docker or Kubernetes, connect to the internal hostname (for example supabase-db:5432), which reaches Postgres without going through the pooler at all.',
        'Or paste the direct connection string from your provider, which already has the right host, port and username.',
      ],
    };
  }

  // --- Authentication --------------------------------------------------------
  if (code === '28P01' || /password authentication failed/i.test(text)) {
    return {
      message: 'Authentication failed — the password was rejected.',
      code: '28P01',
      hints: [
        `Postgres accepted the connection but refused the credentials for "${resolved?.username ?? 'postgres'}".`,
        'Check the password. If you pasted a connection string, make sure special characters are percent-encoded (@ becomes %40).',
      ],
    };
  }
  if (code === '28000' || /role .* does not exist/i.test(text)) {
    return {
      message: `The role "${resolved?.username ?? 'postgres'}" does not exist on this server.`,
      code: '28000',
      hints: ['Most Supabase deployments use the "postgres" role. Check the username.'],
    };
  }
  if (code === '3D000' || /database .* does not exist/i.test(text)) {
    return {
      message: `The database "${resolved?.database ?? 'postgres'}" does not exist.`,
      code: '3D000',
      hints: ['Supabase’s database is normally named "postgres".'],
    };
  }

  // --- Network ---------------------------------------------------------------
  if (code === 'ECONNREFUSED') {
    return {
      message: 'Connection refused — nothing is listening on that host and port.',
      code: 'ECONNREFUSED',
      hints: [
        `Nothing accepted a connection on ${resolved?.host ?? 'the host'}:${resolved?.port ?? 5432}.`,
        'Postgres is often not exposed publicly. On Docker Compose or Coolify, the database is usually only on the internal network — run this tool on the same network and use the internal hostname (for example supabase-db).',
        'If it should be public, check the port is published and any firewall or security group allows it.',
      ],
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      message: `The host "${resolved?.host ?? ''}" could not be resolved.`,
      code: code,
      hints: [
        'DNS could not resolve that hostname from this machine.',
        'If it is a Docker or Kubernetes internal name (like supabase-db or supabase-db.default.svc), it only resolves from inside that network.',
      ],
    };
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(text)) {
    return {
      message: 'The connection timed out.',
      code: 'ETIMEDOUT',
      hints: [
        'The host did not answer. A firewall or security group is the usual cause — Postgres is reachable but packets are being dropped.',
        'Raise the connection timeout under Advanced if the server is simply slow to accept.',
      ],
    };
  }

  // --- TLS -------------------------------------------------------------------
  if (/self[- ]signed certificate|certificate/i.test(text)) {
    return {
      message: 'The TLS certificate could not be verified.',
      code: 'CERT',
      hints: [
        'Self-hosted Postgres usually presents a self-signed certificate.',
        'Set SSL to "Require (no verification)" under Advanced to encrypt the connection without validating the certificate chain.',
      ],
    };
  }
  if (/server does not support SSL|SSL is not enabled/i.test(text)) {
    return {
      message: 'The server does not support SSL, but SSL was required.',
      code: 'NO_SSL',
      hints: ['Set SSL to "Disable" under Advanced. This is normal for a database on a private network.'],
    };
  }

  // --- Pooler, generally -----------------------------------------------------
  if (connection?.poolerMode === 'transaction' && /prepared statement|cannot insert multiple commands/i.test(text)) {
    return {
      message: 'A transaction-mode pooler rejected the statement.',
      code: 'POOLER',
      hints: [
        'Transaction poolers do not support prepared statements or session state.',
        'Use Direct PostgreSQL on port 5432 for the migration. Poolers are for application traffic, not schema work.',
      ],
    };
  }

  return {
    message: text === '' ? 'Unable to reach PostgreSQL.' : text,
    code,
    hints: [
      'Check the host, port, database, username and password.',
      'If your Postgres is only on an internal Docker or Kubernetes network, use its internal hostname.',
    ],
  };
}
