/**
 * @file `GET /api/migrations/:id/report?format=html|pdf` — the exportable report.
 */

import { errorResponse, notFound } from '@/core/api/schemas';
import { jobRepository } from '@/core/infra/store';
import { renderHtmlReport, renderPdfReport } from '@/core/services/report.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const job = await jobRepository.find(id);
    if (job === null) return notFound('Migration');

    const url = new URL(request.url);
    const format = url.searchParams.get('format') ?? 'html';
    const download = url.searchParams.get('download') === '1';
    const slug = job.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    if (format === 'pdf') {
      const pdf = await renderPdfReport(job);
      // `Uint8Array` -> a fresh ArrayBuffer, because the view may be a window onto a
      // larger pooled buffer and handing that to Response would send the whole pool.
      const body = pdf.slice().buffer as ArrayBuffer;

      return new Response(body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="nebkern-${slug}.pdf"`,
        },
      });
    }

    const html = renderHtmlReport(job);
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...(download ? { 'Content-Disposition': `attachment; filename="nebkern-${slug}.html"` } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
