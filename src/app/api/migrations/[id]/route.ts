/**
 * @file `GET /api/migrations/:id` and `DELETE /api/migrations/:id`.
 */

import { NextResponse } from 'next/server';
import { errorResponse, notFound } from '@/core/api/schemas';
import { jobRepository } from '@/core/infra/store';
import { credentialVault } from '@/core/infra/vault';
import { migrationRuntime } from '@/core/services/orchestrator';
import { eventBus } from '@/core/infra/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const job = await jobRepository.find(id);
    if (job === null) return notFound('Migration');

    return NextResponse.json({
      ...job,
      // The UI needs both of these to decide which controls to show. Neither is
      // derivable from the persisted document — they are properties of *this*
      // process, not of the job.
      isRunning: migrationRuntime.isRunning(id),
      hasCredentials: credentialVault.has(id, 'source') && credentialVault.has(id, 'destination'),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const job = await jobRepository.find(id);
    if (job === null) return notFound('Migration');

    // Stop it before deleting the file it is checkpointing into.
    migrationRuntime.cancel(id);
    credentialVault.clear(id);
    eventBus.clear(id);
    await jobRepository.remove(id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
