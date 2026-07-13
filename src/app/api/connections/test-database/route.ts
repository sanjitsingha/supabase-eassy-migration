/**
 * @file `POST /api/connections/test-database` — the "Test PostgreSQL" button.
 *
 * Step 5, with full diagnostics: server version, current database, current user,
 * the grants that decide whether a migration can actually write, and the installed
 * extensions.
 *
 * Note this route answers `200` even when the connection fails. The failure *is* the
 * payload — an error code, a plain-English message, and the concrete next steps
 * (which for the Supavisor "no tenant identifier" case is the whole point of the
 * feature). Returning a 5xx here would collapse all that detail into "request
 * failed" on the client.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { credentialsSchema, errorResponse, toCredentials } from '@/core/api/schemas';
import { testDatabase } from '@/core/services/diagnostics.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A dead host can take the full connection timeout to fail. */
export const maxDuration = 120;

const bodySchema = z.object({ credentials: credentialsSchema });

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const { credentials } = bodySchema.parse(body);

    return NextResponse.json(await testDatabase(toCredentials(credentials)));
  } catch (err) {
    // Only a malformed request reaches this. A failed *connection* is a successful
    // response carrying a diagnostic.
    return errorResponse(err);
  }
}
