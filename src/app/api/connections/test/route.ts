/**
 * @file `POST /api/connections/test` — Step 1's "Test Connection" button.
 *
 * Credentials arrive, get probed, and are discarded when the request ends. They are
 * not written anywhere: the vault is only armed once a migration is actually created.
 */

import { NextResponse } from 'next/server';
import { testConnectionSchema, toCredentials, errorResponse } from '@/core/api/schemas';
import { testConnection } from '@/core/services/connection.service';

// `pg` and `node:crypto` need the Node runtime; the Edge runtime has neither.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const { credentials, role } = testConnectionSchema.parse(body);

    const result = await testConnection(toCredentials(credentials), role);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
