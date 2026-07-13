/**
 * @file `GET /api/migrations` (history) and `POST /api/migrations` (create).
 *
 * Creating a migration is where credentials enter the vault. The job document that
 * lands on disk holds only a redacted {@link EndpointSummary} — type, URL, project
 * ref, transport. No key, no password, no token, ever.
 */

import { NextResponse } from 'next/server';
import type { EndpointSummary, MigrationJob } from '@/core/domain/types';
import { createMigrationSchema, errorResponse, toCredentials, toOptions, toSelection } from '@/core/api/schemas';
import { jobRepository, newId } from '@/core/infra/store';
import { credentialVault } from '@/core/infra/vault';
import { testConnection } from '@/core/services/connection.service';
import { discover } from '@/core/services/discovery.service';
import { parseProjectRef } from '@/core/transport/http';
import { migrationRuntime } from '@/core/services/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(): Promise<NextResponse> {
  try {
    const jobs = await jobRepository.list();

    // Reconcile: a job marked `running` that has no live runner is a job whose
    // process died. Report it as paused so the UI offers "Resume" rather than
    // spinning forever on a migration that is not actually moving.
    const reconciled = jobs.map((job) =>
      job.status === 'running' && !migrationRuntime.isRunning(job.id)
        ? { ...job, status: 'paused' as const, error: 'Interrupted — the server restarted. Re-enter credentials to resume.' }
        : job,
    );

    return NextResponse.json(reconciled);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const input = createMigrationSchema.parse(body);

    const source = toCredentials(input.source);
    const destination = toCredentials(input.destination);

    // Probe both ends before committing a job to disk, so the job record can record
    // which transport each side will actually use.
    const [sourceTest, destTest] = await Promise.all([
      testConnection(source, 'source'),
      testConnection(destination, 'destination'),
    ]);

    if (!sourceTest.ok || !destTest.ok) {
      const problems = [...sourceTest.errors.map((e) => `Source: ${e}`), ...destTest.errors.map((e) => `Destination: ${e}`)];
      return NextResponse.json(
        { error: problems.join(' '), code: 'CONNECTION_FAILED', detail: problems.join('\n') },
        { status: 502 },
      );
    }

    const id = newId('mig_');
    const { report } = await discover(source);

    const summarise = (
      creds: typeof source,
      test: typeof sourceTest,
    ): EndpointSummary => ({
      type: creds.type,
      url: creds.url,
      projectRef: parseProjectRef(creds.url),
      transport: test.selectedTransport,
    });

    const job: MigrationJob = {
      id,
      name: input.name,
      status: 'created',
      source: summarise(source, sourceTest),
      destination: summarise(destination, destTest),
      selection: toSelection(input.selection),
      options: toOptions(input.options),
      discovery: report,
      tasks: [],
      stats: {
        rowsMigrated: 0,
        filesMigrated: 0,
        bytesTransferred: 0,
        usersMigrated: 0,
        objectsCreated: 0,
        errors: 0,
        retries: 0,
        skipped: 0,
      },
      validation: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      error: null,
    };

    // Secrets go to the encrypted in-memory vault; the job document does not get them.
    credentialVault.put(id, 'source', source);
    credentialVault.put(id, 'destination', destination);

    await jobRepository.save(job);

    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
