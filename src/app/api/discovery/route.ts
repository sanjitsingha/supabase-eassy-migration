/**
 * @file `POST /api/discovery` — Step 2.
 *
 * Returns only the {@link DiscoveryReport}, not the full introspected schema. The
 * schema of a 1000-table project is megabytes of JSON that the browser has no use
 * for, and Step 4 re-reads it server-side anyway (the source may have changed since
 * discovery ran).
 */

import { NextResponse } from 'next/server';
import { discoverySchema, toCredentials, errorResponse } from '@/core/api/schemas';
import { discover } from '@/core/services/discovery.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Discovery on a very large project runs many catalog queries; give it room. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const { credentials } = discoverySchema.parse(body);

    const { report } = await discover(toCredentials(credentials));
    return NextResponse.json(report);
  } catch (err) {
    return errorResponse(err);
  }
}
