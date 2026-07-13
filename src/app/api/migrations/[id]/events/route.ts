/**
 * @file `GET /api/migrations/:id/events` — the live progress stream (SSE).
 *
 * Server-Sent Events rather than WebSockets: the traffic is entirely one-way
 * (server → browser), SSE rides on plain HTTP so it needs no protocol upgrade or
 * special proxy config, and `EventSource` reconnects automatically on a dropped
 * socket. The event bus keeps a replay buffer, so a reconnecting client is caught up
 * on what it missed rather than resuming from a blank page.
 */

import type { MigrationEvent } from '@/core/domain/types';
import { eventBus } from '@/core/infra/events';
import { jobRepository } from '@/core/infra/store';
import { migrationRuntime } from '@/core/services/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Long-lived connection: on a persistent host it stays open for the life of the
 * migration, kept alive by the 15s comment ping below and reopened automatically by
 * `EventSource` if a proxy or load balancer cuts it. 300 is the ceiling Vercel's
 * platform accepts on any plan (Hobby caps here; paid plans allow more but this route
 * does not depend on staying inside one invocation, so there is no reason to ask for
 * more than the safe universal maximum).
 *
 * This value is irrelevant on a persistent Node process (Docker, a VPS, Railway,
 * Fly.io) — `next start` is not subject to a per-request timeout at all. It only
 * matters if this route is deployed onto a serverless platform, and even then it only
 * fixes the build: serverless functions are frozen once the response is considered
 * "done," which for a stream means the connection drops well before 300s regardless of
 * this number. This app's execution model — a background migration runner living in
 * process memory, an in-memory credential vault, a local file-backed job store — needs
 * a long-running process. See the README's Deployment section.
 */
export const maxDuration = 300;

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const job = await jobRepository.find(id);
  if (job === null) {
    return new Response('Migration not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: MigrationEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client went away between our check and the enqueue.
          closed = true;
        }
      };

      // Open with the full job, so the page can render immediately without a
      // separate fetch and without waiting for the next event to fire.
      send({ type: 'snapshot', job });
      if (!migrationRuntime.isRunning(id) && job.status !== 'running') {
        send({ type: 'status', status: job.status, error: job.error });
      }

      unsubscribe = eventBus.subscribe(id, send);

      // Proxies and load balancers kill idle connections. A comment line every 15s
      // keeps the socket warm without polluting the event stream.
      keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (keepAlive !== null) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      unsubscribe?.();
      if (keepAlive !== null) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold events back until the
      // buffer fills — turning a live stream into a stuttering one.
      'X-Accel-Buffering': 'no',
    },
  });
}
