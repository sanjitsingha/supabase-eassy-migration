/**
 * @file `GET /api/settings` — system state for the Settings page.
 *
 * Reports what the vault currently holds (counts and expiry only — never a secret),
 * how much disk the local job store is using, and the bootstrap SQL a user needs
 * when their self-hosted instance has no reachable Postgres port.
 */

import { NextResponse } from 'next/server';
import { errorResponse } from '@/core/api/schemas';
import { DEFAULTS, VAULT_TTL_MS } from '@/core/domain/constants';
import { credentialVault } from '@/core/infra/vault';
import { dataDirectory, storeFootprint } from '@/core/infra/store';
import { migrationRuntime } from '@/core/services/orchestrator';
import { DROP_EXEC_HELPER_SQL, EXEC_HELPER_SQL } from '@/core/transport/transports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const [footprint, directory] = await Promise.all([storeFootprint(), dataDirectory()]);

    return NextResponse.json({
      defaults: DEFAULTS,
      vault: {
        // Only metadata. There is deliberately no endpoint that can read a secret
        // back out of the vault — not even for the UI that put it there.
        entries: credentialVault.inspect(),
        ttlMs: VAULT_TTL_MS,
      },
      store: { ...footprint, directory },
      running: migrationRuntime.runningIds(),
      helperSql: { install: EXEC_HELPER_SQL, drop: DROP_EXEC_HELPER_SQL },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Wipes every credential the process is holding. The Settings page's panic button. */
export async function DELETE(): Promise<NextResponse> {
  try {
    const held = credentialVault.inspect();
    for (const entry of held) credentialVault.clear(entry.jobId);
    return NextResponse.json({ ok: true, cleared: held.length });
  } catch (err) {
    return errorResponse(err);
  }
}
