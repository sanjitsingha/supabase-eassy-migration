/**
 * @file `GET /api/migrations/:id/logs` — search, page, and download logs.
 *
 * `?download=1` streams the raw NDJSON with a `Content-Disposition` attachment
 * header, which is the "Download Logs" button. NDJSON rather than a formatted text
 * dump because it stays machine-readable — the user can pipe it into `jq` or load it
 * into a log tool without re-parsing prose.
 */

import { NextResponse } from 'next/server';
import type { LogLevel, StageId } from '@/core/domain/types';
import { errorResponse } from '@/core/api/schemas';
import { logRepository } from '@/core/infra/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'success'];

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);

    if (url.searchParams.get('download') === '1') {
      const raw = await logRepository.raw(id);
      return new Response(raw, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': `attachment; filename="nebkern-${id}-logs.ndjson"`,
        },
      });
    }

    const levelsParam = url.searchParams.get('levels');
    const levels = levelsParam !== null
      ? levelsParam.split(',').filter((l): l is LogLevel => (LEVELS as readonly string[]).includes(l))
      : undefined;

    const stagesParam = url.searchParams.get('stages');
    const stages = stagesParam !== null ? (stagesParam.split(',') as (StageId | 'system')[]) : undefined;

    const result = await logRepository.query(id, {
      ...(url.searchParams.get('search') !== null ? { search: url.searchParams.get('search') ?? '' } : {}),
      ...(levels !== undefined && levels.length > 0 ? { levels } : {}),
      ...(stages !== undefined && stages.length > 0 ? { stages } : {}),
      limit: clamp(url.searchParams.get('limit'), 500, 1, 5000),
      offset: clamp(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
