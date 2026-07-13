/**
 * @file The bootstrap SQL for the RPC transport.
 *
 * Lives in its own module, separate from `transports.ts`, for one reason: the setup UI
 * needs to *display* this SQL so the user can paste it into their Supabase SQL editor,
 * and that UI is a client component. `transports.ts` imports `pg`, which must never be
 * pulled into a browser bundle. Splitting the string out keeps the import graph honest.
 *
 * ## Why this exists at all
 *
 * A self-hosted Supabase has no Management API, so the tool needs *some* way to run SQL.
 * The obvious answer is a direct Postgres connection — but on most real self-hosted
 * deployments (Docker Compose, Coolify, Kubernetes) Postgres is deliberately bound to
 * the internal network only, and port 5432 is not reachable from outside. Exposing it to
 * the public internet just to run a migration is a genuinely bad trade.
 *
 * These two functions solve that. They turn PostgREST — which is *already* exposed,
 * because that is the whole point of a Supabase API gateway — into a SQL channel. No new
 * ports, no firewall changes, no network topology to reason about. If the API works, SQL
 * works.
 *
 * ## The security posture, stated plainly
 *
 * `security definer` + arbitrary SQL means these functions are, by construction, a
 * full-database backdoor for anyone who can call them. That is not a side effect; it is
 * what makes them useful. So:
 *
 * - `revoke` from `public`, `anon` and `authenticated` — an anon-key holder (i.e. anyone
 *   with your public frontend key) must never be able to reach these.
 * - `grant` to `service_role` alone, which is already a full-access credential. So this
 *   grants no privilege that the service role did not already have; it only changes the
 *   *channel* through which it is exercised.
 * - Drop them when the migration is done. {@link DROP_EXEC_HELPER_SQL} is offered in the
 *   UI for exactly that, and the tool nags about it.
 */

import { EXEC_SQL_FUNCTION } from '@/core/domain/constants';

/**
 * Installs the two helper functions.
 *
 * Two functions rather than one because a query returning rows and a DDL statement
 * returning nothing need different shapes. Trying to serve both from a single function
 * means either wrapping DDL in a `SELECT` (a syntax error) or catching the syntax error
 * and re-executing — which would then silently swallow *genuine* syntax errors in the
 * user's own SQL. Two functions keeps the failure modes distinguishable.
 */
export const EXEC_HELPER_SQL = `
-- ============================================================================
-- Nebkern Migration Tool — SQL execution helpers
--
-- Lets the migration run SQL over your existing Supabase API, so you do NOT
-- need to expose the Postgres port (5432) to the internet.
--
-- These functions run as SECURITY DEFINER, so they are restricted to the
-- service_role only. Drop them when your migration is finished (the Settings
-- page has the SQL for that).
-- ============================================================================

create or replace function public.${EXEC_SQL_FUNCTION}(query text)
returns jsonb
language plpgsql
security definer
as $nebkern$
declare
  result jsonb;
begin
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query) into result;
  return result;
end;
$nebkern$;

create or replace function public.${EXEC_SQL_FUNCTION}_ddl(query text)
returns void
language plpgsql
security definer
as $nebkern$
begin
  execute query;
end;
$nebkern$;

-- Lock these down. The anon key must never be able to reach them.
revoke all on function public.${EXEC_SQL_FUNCTION}(text) from public, anon, authenticated;
revoke all on function public.${EXEC_SQL_FUNCTION}_ddl(text) from public, anon, authenticated;
grant execute on function public.${EXEC_SQL_FUNCTION}(text) to service_role;
grant execute on function public.${EXEC_SQL_FUNCTION}_ddl(text) to service_role;
`.trim();

/** Removes the helpers. Offered as a post-migration cleanup action. */
export const DROP_EXEC_HELPER_SQL = `
drop function if exists public.${EXEC_SQL_FUNCTION}(text);
drop function if exists public.${EXEC_SQL_FUNCTION}_ddl(text);
`.trim();
