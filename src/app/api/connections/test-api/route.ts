/**
 * @file `POST /api/connections/test-api` — the "Test API" button.
 *
 * Steps 1–4: REST, Auth, Storage, Realtime. Deliberately separate from the database
 * test, because on a self-hosted deployment those two fail for entirely unrelated
 * reasons and a combined pass/fail tells the user nothing about which half to fix.
 *
 * Credentials are used for the request and discarded when it ends. Nothing is stored;
 * the vault is only armed when a migration is actually created.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { credentialsSchema, errorResponse, toCredentials } from '@/core/api/schemas';
import { testApi } from '@/core/services/diagnostics.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ credentials: credentialsSchema });

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const { credentials } = bodySchema.parse(body);

    return NextResponse.json(await testApi(toCredentials(credentials)));
  } catch (err) {
    return errorResponse(err);
  }
}
