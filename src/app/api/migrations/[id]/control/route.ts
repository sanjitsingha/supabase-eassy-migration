/**
 * @file `POST /api/migrations/:id/control` — start, pause, resume, cancel.
 *
 * One route rather than four, because the four share all their guard logic and
 * differ only in the last line.
 *
 * **Resume is the interesting one.** Because credentials are held only in memory, a
 * resume after a server restart has no keys. Rather than failing opaquely, the route
 * returns `409 CREDENTIALS_EXPIRED`, which is the UI's cue to re-prompt and then
 * call back with the keys in the body. That round trip *is* the security model: the
 * only way to continue a migration is to prove you still hold the credentials.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { credentialsSchema, errorResponse, notFound, toCredentials } from '@/core/api/schemas';
import { jobRepository } from '@/core/infra/store';
import { credentialVault } from '@/core/infra/vault';
import { migrationRuntime } from '@/core/services/orchestrator';
import { MigrationError } from '@/core/domain/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A migration runs detached from this request, so the handler itself returns fast. */
export const maxDuration = 60;

const bodySchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel']),
  /** Supplied on resume when the vault has been emptied by a restart. */
  credentials: z
    .object({ source: credentialsSchema, destination: credentialsSchema })
    .optional(),
});

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const job = await jobRepository.find(id);
    if (job === null) return notFound('Migration');

    const body: unknown = await request.json();
    const { action, credentials } = bodySchema.parse(body);

    switch (action) {
      case 'pause': {
        if (!migrationRuntime.pause(id)) {
          return NextResponse.json({ error: 'This migration is not running', code: 'VALIDATION_FAILED' }, { status: 409 });
        }
        return NextResponse.json({ ok: true, status: 'pausing' });
      }

      case 'cancel': {
        // A job that never started, or whose process died, has no live runner to
        // cancel — so mark it cancelled directly rather than reporting failure.
        if (!migrationRuntime.cancel(id)) {
          job.status = 'cancelled';
          job.finishedAt = new Date().toISOString();
          await jobRepository.save(job);
          credentialVault.clear(id);
        }
        return NextResponse.json({ ok: true, status: 'cancelling' });
      }

      case 'start':
      case 'resume': {
        if (migrationRuntime.isRunning(id)) {
          return NextResponse.json({ error: 'This migration is already running', code: 'VALIDATION_FAILED' }, { status: 409 });
        }
        if (job.status === 'completed' || job.status === 'cancelled') {
          return NextResponse.json(
            { error: `This migration is ${job.status} and cannot be restarted`, code: 'VALIDATION_FAILED' },
            { status: 409 },
          );
        }

        // Re-arm the vault if the caller brought keys with them.
        if (credentials !== undefined) {
          credentialVault.put(id, 'source', toCredentials(credentials.source));
          credentialVault.put(id, 'destination', toCredentials(credentials.destination));
        }

        if (!credentialVault.has(id, 'source') || !credentialVault.has(id, 'destination')) {
          throw new MigrationError(
            'CREDENTIALS_EXPIRED',
            'Credentials for this migration are no longer held in memory. They are never written to disk, so re-enter them to continue from the last checkpoint.',
          );
        }

        await migrationRuntime.start(id);
        return NextResponse.json({ ok: true, status: 'running' });
      }
    }
  } catch (err) {
    return errorResponse(err);
  }
}
