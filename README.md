# Nebkern Migration Tool

Migrates an entire Supabase project — schema, data, storage, auth, edge functions — between instances.

Supports **Cloud → Self-hosted**, **Self-hosted → Self-hosted**, and **Cloud → Cloud**. Resumable: if a migration stops halfway, it continues from the row and file it stopped at.

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # lint + typecheck + verification suites + build
```

---

## The one design decision that shapes everything

The brief asks for migration "through Supabase APIs wherever possible instead of `pg_dump`". There is a hard constraint hiding in that sentence, worth being explicit about:

**No Supabase API can read DDL.** PostgREST exposes your *tables*, not your `CREATE TABLE`. There is no endpoint that returns a schema definition, an index, a trigger, or an RLS policy.

So "no pg_dump" cannot mean "no SQL" — it means **no subprocess, no binary, no version-matched dump format**. What this tool actually does:

| Concern | How it moves |
|---|---|
| Schema (DDL) | `SELECT`s against `pg_catalog`, then DDL we generate ourselves |
| Row data | `jsonb_agg` → text → `jsonb_populate_recordset` |
| Storage | Storage HTTP API (`/storage/v1`), TUS resumable upload for large files |
| Auth | `auth.*` tables over SQL, GoTrue Admin API as fallback |
| Edge Functions | Management API (`api.supabase.com`) |
| Realtime | `CREATE PUBLICATION` |

Every SQL statement runs over one of three interchangeable transports, chosen automatically:

1. **Management API** — `POST /v1/projects/{ref}/database/query`. Needs a Personal Access Token. Preferred on Cloud: no database password, and immune to the IPv4/IPv6 problem that now affects direct `db.<ref>.supabase.co` connections.
2. **RPC** — a `security definer` helper reachable via PostgREST. Needs only the service role key, but the helper must be installed first (the Settings page gives you the SQL).
3. **Direct Postgres** — needs the database password. The **only** option for a self-hosted instance, which has no Management API at all.

`SqlTransport` is the interface; every repository above it is written once and works against any Supabase instance regardless of how we got a SQL channel to it. That is the whole architecture in one sentence.

---

## Four things that are easy to get wrong

**1. Row data is never parsed by JavaScript.**
Rows are aggregated by Postgres into a single JSON document and handed to us as **text**, which we pass straight back to the destination as text. `JSON.parse` would turn every number into an IEEE-754 double — so a `numeric(30,10)` money column would silently lose precision in transit. Keeping the payload opaque also means `bytea`, arrays, ranges, composites, enums and PostGIS all work for free, because Postgres's own type I/O functions do the work at both ends.

The verification suite asserts `123456789012345678.1234567891` survives exactly.

**2. Foreign keys, indexes and triggers are applied *after* the data, not before.**
The same pre-data/data/post-data split `pg_restore` uses. It buys three things:

- **Tables copy in parallel, in any order.** Nothing exists to violate, so no topological sort is needed — and **circular foreign keys work**. (A ⇄ B has no valid insertion order while both FKs are enabled; no ordering scheme can fix that, only deferring the constraints can.)
- Inserts don't pay index-maintenance cost — building an index once over a finished table is dramatically cheaper.
- `ON INSERT` triggers don't fire once per migrated row, duplicating data or firing webhooks.

**3. Keyset pagination, never `OFFSET`.**
`OFFSET n` makes Postgres walk and discard n rows on every page, so paging a table that way is O(n²). We remember the last key and ask for `WHERE key > :cursor ORDER BY key LIMIT n`, which is an index seek and costs the same on page 1 and page 10,000. It is also exactly what makes the copy resumable: **the cursor is the checkpoint.** Tables with no primary key fall back to `ctid` ordering.

**4. Supabase-managed schemas get their data, never their DDL.**
A destination project already has an `auth.users` at its own GoTrue version. Replaying the source's `CREATE TABLE auth.users` over it would fail — or worse, silently downgrade it. So `auth`, `storage`, `realtime`, `vault`, `graphql` and friends are **data-only**, and the columns copied are the *intersection* of source and destination, which is what lets two instances on different GoTrue versions migrate at all.

Every other schema — `public` **and every custom schema** — gets full DDL.

---

## Connecting a self-hosted instance

A self-hosted Supabase is **two independent systems**: an HTTP API behind a gateway (Kong), and a Postgres server. On a real deployment they are frequently on different hosts, different networks, and they fail for entirely unrelated reasons. So Step 1 tests them separately, with separate buttons and separate diagnostics — a combined "Test Connection" that just says *failed* tells you nothing about which half to fix.

**Supabase API** — the Kong address serving `/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1`. Not the Studio dashboard. *Test API* probes all four and shows each independently; Realtime is treated as optional, because every stage except the publication works without it.

The service role key is decoded in the browser as you type. Pasting the **anon key** is the most common setup mistake and the worst one: it authenticates perfectly happily, then reads almost nothing because RLS is doing its job — so the migration "succeeds" against an empty database. It is rejected outright.

**Database Connection** — required, and expanded by default, because self-hosted Supabase has no Management API. Without a Postgres connection there is no way to read a schema at all.

Two input modes, kept in sync (paste a URL and the fields fill; edit a field and the URL is rebuilt), because different hosts hand you different things:

| Deployment | What you typically have |
|---|---|
| Railway, Coolify, DigitalOcean | a connection string — paste it |
| Docker Compose | internal hostname `supabase-db:5432` |
| Kubernetes | `supabase-db.default.svc.cluster.local` |
| VPS / custom proxy | a public host, or an IP |

*Test PostgreSQL* reports the server version, the database, the user it connected as, the **grants that actually decide whether a migration can write** (checked with `has_*_privilege`, not inferred from superuser — a properly locked-down role can migrate fine and should not be told otherwise), and the installed extensions.

### Supavisor and `ENOIDENTIFIER`

The single most confusing failure in the self-hosted ecosystem. Supabase's pooler encodes the tenant in the *username* (`postgres.<ref>`); connect with a bare `postgres` and it rejects you with **"no tenant identifier"** — which explains nothing and suggests nothing.

The tool recognises Supavisor *before dialling* (from the hostname, port 6543, or a tenant-qualified username), and when it sees that error it says what to do: qualify the username, or — better for a migration — bypass the pooler entirely and use **Direct PostgreSQL on 5432**, or the internal Docker hostname, which does not go through the pooler at all.

This matters beyond the error message. A transaction-mode pooler cannot hold session state or prepared statements, and schema work depends on both. Poolers are built for application traffic, not migrations.

**Advanced** covers SSL mode (self-hosted Postgres usually presents a self-signed certificate, so *Require, no verification* is the common choice — made explicit rather than silently disabling verification on every connection), pooler mode, and connection timeout.

---

## Resumability

A migration is a list of independently checkpointable tasks. Each carries a cursor, written to disk (atomically: temp file → `fsync` → `rename`) the moment it advances. Two levels of resume:

- **Between tasks** — a completed task is never redone. Restarting after 800 of 1000 tables begins at table 801.
- **Within a task** — a table that died 900,000 rows into a million restarts at row 900,001.

The second level is the one most tools skip, and it is the difference between being resumable and merely looking resumable. It is directly verified: `verify-resume.ts` copies 1,750 of 5,000 rows, throws the reader away, resumes a fresh one from the checkpoint, and asserts the destination ends with exactly 5,000 rows — no loss, no duplication, no gaps, and nothing before the cursor re-read.

**Error policy.** A failing unit is retried with exponential backoff and full jitter (jitter, not fixed backoff — six storage workers that all get 429'd would otherwise retry in lockstep and get 429'd again). If it still fails it is logged, marked failed, and the migration *moves on*. The job ends `completed_with_errors`, and the validation report names exactly what did not make it. Only an explicit cancel stops everything.

---

## Security, and what it honestly buys you

Service role keys are held **only in this process's memory**, AES-256-GCM encrypted under a key generated fresh at every process start, with a TTL and auto-wipe. Nothing is written to disk — the persisted job record holds the URL, project ref and transport, and no secret.

This defends against the realistic threat: a heap dump, a core file, an accidental log line. It does **not** defend against code running inside this process, which can simply call `vault.get()`. No in-process scheme can, and claiming otherwise would be theatre.

The visible consequence: **restarting the server loses the keys, so resuming asks for them again.** That is the design working, not a gap. Your progress is on disk and untouched; supplying the keys continues from the last checkpoint.

---

## Verification

The engine is tested against **real Postgres**. PGlite is Postgres compiled to WebAssembly, so there is a real planner, a real `pg_catalog`, and real type input/output functions. The harnesses drive the production code paths, not mocks.

```bash
npm run verify:migration    # 47 checks — introspection, DDL, copy, fidelity, integrity
npm run verify:resume       # 33 checks — checkpoint/resume, SQL encoding, retry, pool, limiter, vault
npm run verify:connection   # 27 checks — connection-string parsing, pooler detection, key inspection
npm run verify:database     # 23 checks — "Test PostgreSQL" against a real TCP Postgres socket
npm run verify              # all of the above
```

The fixture is deliberately hostile. It contains the things that break naive migration tools: a non-public schema, an enum and a composite type, a `numeric(30,10)` column, `bytea` / `jsonb` / `text[]`, a `GENERATED ALWAYS ... STORED` column, an `IDENTITY ALWAYS` column, **a circular foreign-key pair**, a table with no primary key, a partial index, a view over a view, a trigger, RLS policies, and a sequence whose value must carry across or the first post-migration insert collides.

`verify:database` goes further and exposes PGlite over a **real TCP socket**, so the `pg` client dials an actual Postgres wire protocol — the same code path the production migration uses, sockets and all. It runs against a Postgres with *no Supabase roles at all*, which is the shape of a bare destination or a hardened self-host.

The suites found real bugs during development, which is what they are for:

- `bigserial` sequences were never created (`CREATE TABLE` makes an `IDENTITY` column's sequence, but not a `serial`'s).
- The bandwidth limiter barely throttled — it only waited at a zero balance, so any positive balance let a caller take an unlimited amount.
- The permission probe called `pg_has_role(current_user, 'supabase_admin', 'MEMBER')`, which **raises** when that role does not exist. On any Postgres without a full Supabase stack it aborted the whole database test and reported the misleading "the role postgres does not exist" — failing on precisely the deployments this tool is for.

---

## Known limitations

Stated plainly rather than buried:

- **Edge Functions are Cloud-only.** The Management API is a hosted-platform service; a self-hosted Supabase runs Deno functions from a local directory and exposes no deploy endpoint. Cloud → Cloud is fully automatic. Cloud → self-hosted reads the sources and tells you to commit them to `supabase/functions/` — it does not pretend to have deployed them. Self-hosted → anywhere has nothing to read.
- **Auth without a SQL transport is lossy.** The GoTrue Admin API can preserve user ids and password hashes, but it cannot create identities (OAuth links), MFA factors, or sessions. The tool warns loudly when it has to fall back to that path. With SQL on both ends, all of it migrates.
- **Range types are skipped.** Recreating one needs the subtype's operator class, which is not introspected. A warning is logged rather than emitting a guessed `CREATE TYPE`.
- **Foreign tables (FDW)** are not migrated; they need their server and wrapper configured out of band.
- **Job state is local.** Single-instance by design: `.nebkern/` on disk, in-memory runtime registry. Running behind a load balancer would need `JobRepository` swapped for Postgres — the interface exists for exactly that.

---

## Architecture

```
src/core/
  domain/          types, error taxonomy (retryable vs not), Supabase schema constants
  transport/       SqlTransport + 3 implementations, literal encoding, HTTP client
  repositories/    introspection · data · storage · auth · edge-function
  ddl/             catalog model → executable DDL, phase ordering, topological sort
  services/        connection · discovery · orchestrator · validation · report
  infra/           encrypted vault · retry · concurrency pool · token bucket ·
                   throughput meter · event bus · crash-safe atomic store
  api/             Zod schemas, error → HTTP status mapping
src/app/           Next.js routes (UI + API), SSE progress stream
src/components/    shadcn/ui primitives, app components
scripts/           verification harnesses (real Postgres via PGlite)
```

**Stack:** Next.js 16, TypeScript (strict, `noUncheckedIndexedAccess`, no `any`), Tailwind v4, shadcn/ui, Supabase JS v2.

Values that are genuinely unknown at compile time — a row from an arbitrary user table — are typed `unknown` and narrowed at the point of use, rather than cast to `any`.
#   s u p a b a s e - e a s s y - m i g r a t i o n  
 