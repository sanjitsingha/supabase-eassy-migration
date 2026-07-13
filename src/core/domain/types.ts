/**
 * @file The domain model for the Nebkern Migration Tool.
 *
 * Every layer above (transports, repositories, services, API routes, UI) types
 * against the shapes declared here. There are no `any`s: where a value is
 * genuinely unknown at compile time — a row read out of an arbitrary user table,
 * for instance — it is typed `unknown` and narrowed at the point of use.
 */

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type InstanceType = 'cloud' | 'self_hosted';

export type EndpointRole = 'source' | 'destination';

/** How the user chose to describe the Postgres connection. */
export type ConnectionMode = 'connection_string' | 'manual';

/**
 * TLS policy for the Postgres socket.
 *
 * `no-verify` is separate from `require` because it is the setting almost every
 * self-hosted deployment actually needs: TLS is on, but the certificate is
 * self-signed or issued for an internal hostname, so verification would fail.
 * Making it an explicit choice is honest; silently disabling verification (which
 * is what a bare `rejectUnauthorized: false` does) is not.
 */
export type SslMode = 'disable' | 'prefer' | 'require' | 'no-verify';

/**
 * Which connection pooler, if any, sits in front of Postgres.
 *
 * This matters far more than it looks. Supabase's pooler (Supavisor) demands the
 * tenant be encoded in the username (`postgres.<ref>`), and rejects a bare
 * `postgres` with the notoriously opaque "no tenant identifier". A transaction-mode
 * pooler also refuses session-scoped statements like `SET statement_timeout`, which
 * this tool issues on connect. So the pooler mode is a real behavioural switch, not
 * a label.
 */
export type PoolerMode = 'direct' | 'transaction' | 'session';

/**
 * A Postgres connection, described either as a URL or field-by-field.
 *
 * Both forms are kept in sync in the UI — pasting a connection string fills the
 * fields, and editing a field rebuilds the string — because different deployments
 * hand you different things. Railway and Coolify give you a URL; a Docker Compose
 * or Kubernetes setup gives you an internal hostname (`supabase-db`) and you fill
 * in the rest.
 */
export interface DatabaseConnection {
  readonly mode: ConnectionMode;
  /** Used when `mode` is `connection_string`. */
  readonly connectionString?: string;
  /** Used when `mode` is `manual`. */
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly username?: string;
  readonly password?: string;
  readonly ssl: SslMode;
  readonly poolerMode: PoolerMode;
  readonly connectionTimeoutMs: number;
}

/**
 * The credentials for one end of a migration.
 *
 * `serviceRoleKey` is the only universally required secret. The rest unlock
 * progressively more capable SQL transports:
 *
 * - `accessToken` (a Supabase Personal Access Token) enables the Management API
 *   transport on **Cloud** projects — the only way to read DDL and deploy Edge
 *   Functions without a database password.
 * - `database` enables the direct Postgres transport, which is the **only** way to
 *   introspect a self-hosted instance, because self-hosted Supabase ships no
 *   Management API at all.
 */
export interface SupabaseCredentials {
  readonly type: InstanceType;
  /** Base API URL — Kong's address, e.g. `https://api.example.com` or `http://localhost:8000`. */
  readonly url: string;
  readonly serviceRoleKey: string;
  /** Supabase Personal Access Token (`sbp_...`). Cloud only. */
  readonly accessToken?: string;
  /** Full Postgres connection detail. Required for self-hosted; optional on Cloud. */
  readonly database?: DatabaseConnection;
  /**
   * Shorthand for a Cloud project's database password.
   *
   * Retained because on Cloud the host is derivable from the project ref, so the
   * password is genuinely the only thing we need. `database`, when present, wins.
   */
  readonly dbPassword?: string;
}

/** Which SQL execution strategies an endpoint was able to establish. */
export type TransportKind = 'management_api' | 'rpc' | 'postgres';

export interface TransportCapability {
  readonly kind: TransportKind;
  readonly available: boolean;
  /** Populated when `available` is false — why this transport could not be used. */
  readonly reason?: string;
}

export type SupabaseService = 'rest' | 'auth' | 'storage' | 'realtime';

/** The outcome of probing one Supabase HTTP service. */
export interface ServiceProbe {
  readonly service: SupabaseService;
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly error: string | null;
  /** Realtime is optional: a migration can complete without it. */
  readonly optional: boolean;
}

/** What we can tell about a service role key without calling anything. */
export interface KeyInspection {
  /** `service_role`, `anon`, or null when the key is not a decodable JWT. */
  readonly role: string | null;
  /** Project ref embedded in the JWT, when present. */
  readonly ref: string | null;
  readonly expiresAt: string | null;
  readonly expired: boolean;
  /** New-style `sb_secret_…` keys are opaque, not JWTs. */
  readonly opaque: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Result of "Test API" — steps 1 through 4. */
export interface ApiTestResult {
  readonly ok: boolean;
  readonly url: string;
  readonly projectRef: string | null;
  readonly probes: readonly ServiceProbe[];
  readonly key: KeyInspection;
  readonly latencyMs: number;
  readonly hints: readonly string[];
}

export interface DatabasePermission {
  readonly key: 'create_schema' | 'create_table' | 'create_extension' | 'replication' | 'superuser';
  readonly label: string;
  readonly granted: boolean;
  /** Why it matters — shown when the permission is missing. */
  readonly required: string;
}

/** The resolved connection, echoed back so the user can see what we actually dialled. */
export interface ResolvedConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly ssl: SslMode;
}

/** Result of "Test PostgreSQL" — step 5, with full diagnostics. */
export interface DatabaseTestResult {
  readonly ok: boolean;
  /** Short form, e.g. `17.6`. */
  readonly version: string | null;
  readonly versionFull: string | null;
  readonly database: string | null;
  readonly user: string | null;
  readonly permissions: readonly DatabasePermission[];
  readonly extensions: readonly { readonly name: string; readonly version: string }[];
  readonly resolved: ResolvedConnection | null;
  /** Set when the endpoint we reached is a pooler rather than Postgres itself. */
  readonly pooler: 'supavisor' | 'pgbouncer' | null;
  readonly error: string | null;
  readonly errorCode: string | null;
  /** Actionable next steps, specific to the failure. */
  readonly hints: readonly string[];
  readonly latencyMs: number;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly role: EndpointRole;
  readonly instanceType: InstanceType;
  /** Project ref parsed from a Cloud URL, or the self-hosted host. */
  readonly projectRef: string | null;
  readonly api: ApiTestResult;
  /** Null when no database connection was configured. */
  readonly database: DatabaseTestResult | null;
  readonly transports: readonly TransportCapability[];
  /** The transport that will actually be used for DDL. Null when none work. */
  readonly selectedTransport: TransportKind | null;
  readonly latencyMs: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Introspection model
// ---------------------------------------------------------------------------

export interface ColumnDef {
  readonly name: string;
  readonly position: number;
  /** Fully-qualified formatted type, e.g. `character varying(255)`, `public.mood`. */
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly defaultExpr: string | null;
  readonly identity: 'ALWAYS' | 'BY DEFAULT' | null;
  readonly identityOptions: string | null;
  readonly generatedExpr: string | null;
  readonly collation: string | null;
  readonly comment: string | null;
}

export interface ConstraintDef {
  readonly name: string;
  /** p = primary key, u = unique, f = foreign key, c = check, x = exclusion. */
  readonly kind: 'p' | 'u' | 'f' | 'c' | 'x';
  /** Output of `pg_get_constraintdef` — already valid SQL. */
  readonly definition: string;
  /** For FKs: the schema-qualified table this constraint depends on. */
  readonly referencedTable: string | null;
  readonly isDeferrable: boolean;
}

export interface IndexDef {
  readonly name: string;
  /** Output of `pg_get_indexdef` — already valid SQL. */
  readonly definition: string;
  readonly isPrimary: boolean;
  readonly isUnique: boolean;
  /** Indexes that back a constraint are created by the constraint, not separately. */
  readonly isConstraintBacked: boolean;
}

export interface PolicyDef {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly usingExpr: string | null;
  readonly checkExpr: string | null;
}

export interface TriggerDef {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  /** Output of `pg_get_triggerdef` — already valid SQL. */
  readonly definition: string;
  readonly enabledState: 'O' | 'D' | 'R' | 'A';
}

export interface TableDef {
  readonly schema: string;
  readonly name: string;
  readonly kind: 'table' | 'partitioned' | 'foreign';
  readonly columns: readonly ColumnDef[];
  readonly constraints: readonly ConstraintDef[];
  readonly indexes: readonly IndexDef[];
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly comment: string | null;
  readonly partitionExpr: string | null;
  readonly parentTable: string | null;
  /** Estimated live rows from `pg_class.reltuples`; -1 when never analysed. */
  readonly estimatedRows: number;
  /** Total on-disk size including indexes and TOAST, in bytes. */
  readonly totalBytes: number;
  /**
   * Columns forming the key used for keyset pagination during the data copy.
   * Empty when the table has no primary key or unique index, in which case the
   * copier falls back to `ctid` ordering.
   */
  readonly copyKey: readonly string[];
  /** Columns that are `GENERATED ALWAYS AS (...) STORED` — never written on insert. */
  readonly generatedColumns: readonly string[];
}

export interface ViewDef {
  readonly schema: string;
  readonly name: string;
  readonly materialized: boolean;
  /** Output of `pg_get_viewdef(oid, true)`. */
  readonly definition: string;
  readonly comment: string | null;
  /** Views this view selects from, used to order creation. */
  readonly dependsOn: readonly string[];
  readonly isSecurityInvoker: boolean;
}

export interface RoutineDef {
  readonly schema: string;
  readonly name: string;
  /** Distinguishes overloads: the identity args, e.g. `(a integer, b text)`. */
  readonly identityArgs: string;
  readonly kind: 'function' | 'procedure' | 'aggregate' | 'window';
  /** Output of `pg_get_functiondef` — a complete `CREATE OR REPLACE ...`. */
  readonly definition: string;
  readonly language: string;
  readonly comment: string | null;
}

export interface SequenceDef {
  readonly schema: string;
  readonly name: string;
  readonly dataType: string;
  readonly startValue: string;
  readonly minValue: string;
  readonly maxValue: string;
  readonly incrementBy: string;
  readonly cycles: boolean;
  readonly cacheSize: string;
  readonly lastValue: string | null;
  /** Set when the sequence is owned by a serial/identity column. */
  readonly ownedBy: { readonly schema: string; readonly table: string; readonly column: string } | null;
  /**
   * True when the owning column is `GENERATED ... AS IDENTITY` rather than `serial`.
   *
   * The distinction decides whether we must create the sequence ourselves. Postgres
   * creates an identity column's sequence as part of `CREATE TABLE`, so emitting our
   * own would be a duplicate. A `serial` column, by contrast, we emit as a plain
   * `bigint DEFAULT nextval(...)`, so nothing creates the sequence unless we do —
   * and the table then fails with "relation ..._id_seq does not exist".
   */
  readonly ownedByIdentity: boolean;
}

export interface TypeDef {
  readonly schema: string;
  readonly name: string;
  readonly kind: 'enum' | 'composite' | 'domain' | 'range';
  /** Enum labels, in sort order. */
  readonly enumLabels: readonly string[];
  /** Composite attributes as `name type` pairs. */
  readonly attributes: readonly { readonly name: string; readonly type: string }[];
  /** Domain base type + constraints. */
  readonly domainBase: string | null;
  readonly domainNotNull: boolean;
  readonly domainDefault: string | null;
  readonly domainChecks: readonly string[];
  readonly comment: string | null;
}

export interface ExtensionDef {
  readonly name: string;
  readonly schema: string;
  readonly version: string;
  readonly comment: string | null;
}

export interface SchemaDef {
  readonly name: string;
  readonly owner: string;
  readonly comment: string | null;
  /** True when Supabase/Postgres owns this schema — DDL is skipped, data may not be. */
  readonly managed: boolean;
}

export interface GrantDef {
  readonly schema: string;
  readonly objectName: string;
  readonly objectKind: 'table' | 'sequence' | 'function' | 'schema';
  readonly grantee: string;
  readonly privileges: readonly string[];
}

export interface PublicationDef {
  readonly name: string;
  readonly allTables: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly truncate: boolean;
  readonly tables: readonly { readonly schema: string; readonly table: string }[];
}

/** The complete introspected shape of a Postgres database. */
export interface DatabaseSchema {
  readonly schemas: readonly SchemaDef[];
  readonly extensions: readonly ExtensionDef[];
  readonly types: readonly TypeDef[];
  readonly sequences: readonly SequenceDef[];
  readonly tables: readonly TableDef[];
  readonly views: readonly ViewDef[];
  readonly routines: readonly RoutineDef[];
  readonly triggers: readonly TriggerDef[];
  readonly policies: readonly PolicyDef[];
  readonly grants: readonly GrantDef[];
  readonly publications: readonly PublicationDef[];
}

// ---------------------------------------------------------------------------
// Storage / Auth / Edge Functions
// ---------------------------------------------------------------------------

export interface BucketDef {
  readonly id: string;
  readonly name: string;
  readonly public: boolean;
  readonly fileSizeLimit: number | null;
  readonly allowedMimeTypes: readonly string[] | null;
  readonly createdAt: string | null;
  readonly avifAutodetection: boolean;
}

export interface StorageObjectRef {
  readonly bucketId: string;
  /** Full path within the bucket, e.g. `users/42/avatar.png`. */
  readonly name: string;
  readonly size: number;
  readonly mimeType: string | null;
  readonly cacheControl: string | null;
  readonly lastModified: string | null;
  /** Arbitrary user metadata attached at upload time. */
  readonly userMetadata: Record<string, unknown> | null;
  readonly etag: string | null;
}

export interface EdgeFunctionDef {
  readonly slug: string;
  readonly name: string;
  readonly version: number;
  readonly status: string;
  readonly verifyJwt: boolean;
  readonly importMap: boolean;
  readonly entrypointPath: string | null;
  readonly importMapPath: string | null;
  /** File bodies, keyed by relative path. Populated lazily. */
  readonly files: Readonly<Record<string, string>> | null;
}

// ---------------------------------------------------------------------------
// Discovery (Step 2)
// ---------------------------------------------------------------------------

export interface DiscoveryReport {
  readonly generatedAt: string;
  readonly projectRef: string | null;
  readonly instanceType: InstanceType;
  readonly supabaseVersion: string | null;
  readonly postgresVersion: string | null;
  readonly transport: TransportKind;
  readonly counts: {
    readonly schemas: number;
    readonly tables: number;
    readonly views: number;
    readonly materializedViews: number;
    readonly functions: number;
    readonly triggers: number;
    readonly policies: number;
    readonly extensions: number;
    readonly sequences: number;
    readonly types: number;
    readonly buckets: number;
    readonly files: number;
    readonly authUsers: number;
    readonly edgeFunctions: number;
    readonly estimatedRows: number;
  };
  readonly storageBytes: number;
  readonly databaseBytes: number;
  readonly realtimeEnabled: boolean;
  readonly realtimeTables: number;
  readonly schemaBreakdown: readonly {
    readonly schema: string;
    readonly managed: boolean;
    readonly tables: number;
    readonly rows: number;
    readonly bytes: number;
  }[];
  readonly buckets: readonly (BucketDef & { readonly objectCount: number; readonly bytes: number })[];
  readonly edgeFunctions: readonly EdgeFunctionDef[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Migration plan & jobs
// ---------------------------------------------------------------------------

/** The selectable units of work from Step 3. */
export type StageId =
  | 'extensions'
  | 'tables'
  | 'data'
  | 'policies'
  | 'functions'
  | 'views'
  | 'triggers'
  | 'buckets'
  | 'storage_files'
  | 'auth_users'
  | 'edge_functions'
  | 'realtime';

export type StageSelection = Readonly<Record<StageId, boolean>>;

export interface MigrationOptions {
  readonly batchSize: number;
  readonly tableConcurrency: number;
  readonly storageConcurrency: number;
  readonly maxRetries: number;
  readonly bandwidthLimitBytesPerSec: number;
  readonly multipartThresholdBytes: number;
  /** Schemas to include. Empty means "every non-system schema discovered". */
  readonly includeSchemas: readonly string[];
  readonly excludeSchemas: readonly string[];
  /** `TRUNCATE` destination tables before copying data. */
  readonly truncateBeforeCopy: boolean;
  /** Skip rows whose primary key already exists, instead of erroring. */
  readonly onConflict: 'skip' | 'update' | 'error';
  /** Overwrite storage objects that already exist at the destination. */
  readonly overwriteStorage: boolean;
  /** Continue past a failing unit of work instead of aborting the stage. */
  readonly continueOnError: boolean;
}

export type JobStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * One resumable unit of work.
 *
 * The `cursor` is what makes the tool resumable: for a data copy it holds the
 * last-copied key, for a bucket it holds the last-copied object path. On resume
 * we do not re-read anything before the cursor, so a job that dies 900k rows into
 * a 1M-row table restarts at row 900,001 — not at row 1.
 */
export interface MigrationTask {
  readonly id: string;
  readonly stage: StageId;
  /** Human label, e.g. `public.orders` or `avatars`. */
  readonly label: string;
  status: TaskStatus;
  /** Total units (rows/files/objects) if known ahead of time, else null. */
  total: number | null;
  processed: number;
  bytes: number;
  attempts: number;
  cursor: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StageProgress {
  readonly stage: StageId;
  status: TaskStatus;
  total: number;
  completed: number;
  failed: number;
}

export interface MigrationStats {
  rowsMigrated: number;
  filesMigrated: number;
  bytesTransferred: number;
  usersMigrated: number;
  objectsCreated: number;
  errors: number;
  retries: number;
  skipped: number;
}

export interface MigrationJob {
  readonly id: string;
  name: string;
  status: JobStatus;
  /** Redacted endpoint descriptors — never the secrets themselves. */
  readonly source: EndpointSummary;
  readonly destination: EndpointSummary;
  readonly selection: StageSelection;
  readonly options: MigrationOptions;
  discovery: DiscoveryReport | null;
  tasks: MigrationTask[];
  stats: MigrationStats;
  validation: ValidationReport | null;
  readonly createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Cumulative wall-clock milliseconds spent running (excludes paused time). */
  elapsedMs: number;
  error: string | null;
}

/** What we persist about an endpoint. Note the absence of any secret material. */
export interface EndpointSummary {
  readonly type: InstanceType;
  readonly url: string;
  readonly projectRef: string | null;
  readonly transport: TransportKind | null;
}

// ---------------------------------------------------------------------------
// Logging & events
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  readonly id: string;
  readonly jobId: string;
  readonly ts: string;
  readonly level: LogLevel;
  readonly stage: StageId | 'system';
  readonly message: string;
  readonly durationMs?: number;
  readonly rows?: number;
  readonly files?: number;
  readonly bytes?: number;
  readonly detail?: string;
}

/** Server-sent event payloads pushed to the live progress page. */
export type MigrationEvent =
  | { readonly type: 'snapshot'; readonly job: MigrationJob }
  | { readonly type: 'task'; readonly task: MigrationTask }
  | { readonly type: 'stats'; readonly stats: MigrationStats; readonly elapsedMs: number }
  | { readonly type: 'status'; readonly status: JobStatus; readonly error: string | null }
  | { readonly type: 'log'; readonly entry: LogEntry }
  | { readonly type: 'throughput'; readonly bytesPerSec: number; readonly rowsPerSec: number; readonly etaMs: number | null };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationStatus = 'pass' | 'warn' | 'fail';

export interface ValidationCheck {
  readonly category: 'rows' | 'buckets' | 'files' | 'users' | 'functions' | 'policies' | 'extensions' | 'views' | 'triggers';
  readonly label: string;
  readonly source: number;
  readonly destination: number;
  readonly status: ValidationStatus;
  readonly note?: string;
}

export interface ValidationReport {
  readonly generatedAt: string;
  readonly status: ValidationStatus;
  readonly checks: readonly ValidationCheck[];
  readonly summary: {
    readonly passed: number;
    readonly warned: number;
    readonly failed: number;
  };
}

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

/** A row returned from arbitrary SQL. Values are `unknown` and narrowed at use. */
export type SqlRow = Record<string, unknown>;

export interface SqlResult<T extends SqlRow = SqlRow> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

/**
 * The one abstraction that makes "no pg_dump" possible.
 *
 * Every implementation can run arbitrary SQL against a Supabase project; they
 * differ only in *how* they get there (HTTPS Management API, a PostgREST RPC, or
 * a direct Postgres socket). Repositories depend on this interface and never
 * know which one they were handed.
 */
export interface SqlTransport {
  readonly kind: TransportKind;
  /** Runs a query and returns rows. `params` use `$1`-style placeholders. */
  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly unknown[]): Promise<SqlResult<T>>;
  /** Runs statements with no result set. */
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  /** True when the transport can run several statements in one atomic batch. */
  readonly supportsTransactions: boolean;
  /** Releases sockets/pools. Safe to call more than once. */
  dispose(): Promise<void>;
}
