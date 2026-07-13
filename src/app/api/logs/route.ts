/**
 * @file `GET /api/logs` — the global Logs page, across every migration.
 */

import { NextResponse } from 'next/server';
import type { LogLevel } from '@/core/domain/types';
import { errorResponse } from '@/core/api/schemas';
import { logRepository } from '@/core/infra/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'success'];

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);

    const levelsParam = url.searchParams.get('levels');
    const levels = levelsParam !== null
      ? levelsParam.split(',').filter((l): l is LogLevel => (LEVELS as readonly string[]).includes(l))
      : undefined;

    const search = url.searchParams.get('search');
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '300', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(1, limitRaw)) : 300;

    const result = await logRepository.queryAll({
      ...(search !== null && search !== '' ? { search } : {}),
      ...(levels !== undefined && levels.length > 0 ? { levels } : {}),
      limit,
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
