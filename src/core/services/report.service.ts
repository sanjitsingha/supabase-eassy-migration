/**
 * @file Migration reports: HTML and PDF.
 *
 * The HTML report is a single self-contained file — inline CSS, no external
 * requests — so it can be emailed, committed to a repo, or opened years later
 * without depending on this application still being installed.
 *
 * The PDF is composed with `pdf-lib`, a pure-JS writer. The alternative
 * (headless Chromium via Puppeteer) would render nicer output but drags a ~150 MB
 * browser download into the install, which is a poor trade for what is essentially
 * a table of numbers.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { MigrationJob, ValidationCheck } from '@/core/domain/types';
import { formatBytes } from '@/core/services/validation.service';

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function renderHtmlReport(job: MigrationJob): string {
  const validation = job.validation;
  const failed = job.tasks.filter((t) => t.status === 'failed');
  const skipped = job.tasks.filter((t) => t.status === 'skipped');

  const statusColour =
    job.status === 'completed' ? '#10b981' : job.status === 'completed_with_errors' ? '#f59e0b' : job.status === 'failed' ? '#ef4444' : '#64748b';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nebkern Migration Report — ${escapeHtml(job.name)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 24px;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f8fafc; color: #0f172a;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { border-bottom: 2px solid #e2e8f0; padding-bottom: 24px; margin-bottom: 32px; }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.02em; }
  h2 { margin: 40px 0 16px; font-size: 19px; letter-spacing: -0.01em; }
  .muted { color: #64748b; font-size: 14px; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 999px;
    background: ${statusColour}1a; color: ${statusColour};
    font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
  .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; }
  .stat .k { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
  .stat .v { font-size: 22px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
  th { background: #f8fafc; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pass { color: #059669; font-weight: 600; }
  .warn { color: #d97706; font-weight: 600; }
  .fail { color: #dc2626; font-weight: 600; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 13px; }
  @media print { body { background: #fff; padding: 0; } .stat, table { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(job.name)}</h1>
    <p class="muted">
      <span class="badge">${job.status.replace(/_/g, ' ')}</span>
      &nbsp;·&nbsp; Migration <code>${escapeHtml(job.id)}</code>
      &nbsp;·&nbsp; Generated ${new Date().toLocaleString()}
    </p>
  </header>

  <h2>Endpoints</h2>
  <table>
    <tr><th></th><th>Type</th><th>URL</th><th>Transport</th></tr>
    <tr>
      <th>Source</th>
      <td>${job.source.type === 'cloud' ? 'Supabase Cloud' : 'Self Hosted'}</td>
      <td><code>${escapeHtml(job.source.url)}</code></td>
      <td>${escapeHtml(job.source.transport ?? '—')}</td>
    </tr>
    <tr>
      <th>Destination</th>
      <td>${job.destination.type === 'cloud' ? 'Supabase Cloud' : 'Self Hosted'}</td>
      <td><code>${escapeHtml(job.destination.url)}</code></td>
      <td>${escapeHtml(job.destination.transport ?? '—')}</td>
    </tr>
  </table>

  <h2>Summary</h2>
  <div class="grid">
    ${stat('Rows migrated', job.stats.rowsMigrated.toLocaleString())}
    ${stat('Files migrated', job.stats.filesMigrated.toLocaleString())}
    ${stat('Data transferred', formatBytes(job.stats.bytesTransferred))}
    ${stat('Auth users', job.stats.usersMigrated.toLocaleString())}
    ${stat('Objects created', job.stats.objectsCreated.toLocaleString())}
    ${stat('Errors', job.stats.errors.toLocaleString())}
    ${stat('Retries', job.stats.retries.toLocaleString())}
    ${stat('Duration', formatDuration(job.elapsedMs))}
  </div>

  ${
    validation
      ? `
  <h2>Validation</h2>
  <p class="muted">
    ${validation.summary.passed} passed · ${validation.summary.warned} warnings · ${validation.summary.failed} failed
  </p>
  <table>
    <tr><th>Check</th><th class="num">Source</th><th class="num">Destination</th><th>Status</th><th>Note</th></tr>
    ${validation.checks.map(validationRow).join('\n    ')}
  </table>`
      : '<h2>Validation</h2><p class="muted">No validation report was produced for this migration.</p>'
  }

  ${
    failed.length > 0
      ? `
  <h2>Failed tasks (${failed.length})</h2>
  <table>
    <tr><th>Stage</th><th>Object</th><th>Error</th></tr>
    ${failed
      .map(
        (t) =>
          `<tr><td>${escapeHtml(t.stage)}</td><td><code>${escapeHtml(t.label)}</code></td><td class="fail">${escapeHtml(t.error ?? 'Unknown')}</td></tr>`,
      )
      .join('\n    ')}
  </table>`
      : ''
  }

  ${
    skipped.length > 0
      ? `
  <h2>Skipped (${skipped.length})</h2>
  <table>
    <tr><th>Stage</th><th>Object</th></tr>
    ${skipped.map((t) => `<tr><td>${escapeHtml(t.stage)}</td><td><code>${escapeHtml(t.label)}</code></td></tr>`).join('\n    ')}
  </table>`
      : ''
  }

  <h2>Tasks</h2>
  <table>
    <tr><th>Stage</th><th>Object</th><th>Status</th><th class="num">Processed</th><th class="num">Total</th></tr>
    ${job.tasks
      .map(
        (t) => `<tr>
      <td>${escapeHtml(t.stage)}</td>
      <td><code>${escapeHtml(t.label)}</code></td>
      <td class="${t.status === 'completed' ? 'pass' : t.status === 'failed' ? 'fail' : t.status === 'skipped' ? 'warn' : ''}">${t.status}</td>
      <td class="num">${t.processed.toLocaleString()}</td>
      <td class="num">${t.total !== null ? t.total.toLocaleString() : '—'}</td>
    </tr>`,
      )
      .join('\n    ')}
  </table>

  <footer>
    Generated by the Nebkern Migration Tool · Started ${job.startedAt !== null ? new Date(job.startedAt).toLocaleString() : '—'}
    · Finished ${job.finishedAt !== null ? new Date(job.finishedAt).toLocaleString() : '—'}
  </footer>
</div>
</body>
</html>`;
}

function stat(label: string, value: string): string {
  return `<div class="stat"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`;
}

function validationRow(check: ValidationCheck): string {
  return `<tr>
      <td>${escapeHtml(check.label)}</td>
      <td class="num">${check.source.toLocaleString()}</td>
      <td class="num">${check.destination.toLocaleString()}</td>
      <td class="${check.status}">${check.status.toUpperCase()}</td>
      <td class="muted">${escapeHtml(check.note ?? '')}</td>
    </tr>`;
}

/** Escapes the five characters that can break out of HTML text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595.28; // A4 portrait, in points.
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

interface PdfCursor {
  page: PDFPage;
  y: number;
}

export async function renderPdfReport(job: MigrationJob): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Nebkern Migration Report — ${job.name}`);
  doc.setCreator('Nebkern Migration Tool');
  doc.setProducer('Nebkern Migration Tool');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const cursor: PdfCursor = { page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };

  const newPageIfNeeded = (needed: number): void => {
    if (cursor.y - needed < MARGIN) {
      cursor.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor.y = PAGE_HEIGHT - MARGIN;
    }
  };

  const text = (value: string, options: { font?: PDFFont; size?: number; colour?: [number, number, number]; indent?: number }): void => {
    const size = options.size ?? 10;
    newPageIfNeeded(size + 6);
    cursor.page.drawText(sanitise(value), {
      x: MARGIN + (options.indent ?? 0),
      y: cursor.y,
      size,
      font: options.font ?? regular,
      color: options.colour ? rgb(...options.colour) : rgb(0.06, 0.09, 0.16),
    });
    cursor.y -= size + 6;
  };

  const heading = (value: string): void => {
    cursor.y -= 10;
    newPageIfNeeded(30);
    text(value, { font: bold, size: 14 });
    cursor.page.drawLine({
      start: { x: MARGIN, y: cursor.y + 4 },
      end: { x: PAGE_WIDTH - MARGIN, y: cursor.y + 4 },
      thickness: 0.75,
      color: rgb(0.89, 0.91, 0.94),
    });
    cursor.y -= 8;
  };

  /** Draws a row of right-aligned numeric columns against a left-aligned label. */
  const row = (label: string, values: readonly string[], colour?: [number, number, number]): void => {
    newPageIfNeeded(16);
    cursor.page.drawText(sanitise(truncateTo(label, 46)), {
      x: MARGIN,
      y: cursor.y,
      size: 9,
      font: regular,
      color: rgb(0.06, 0.09, 0.16),
    });

    const columnWidth = 78;
    values.forEach((value, i) => {
      const right = PAGE_WIDTH - MARGIN - (values.length - 1 - i) * columnWidth;
      const width = regular.widthOfTextAtSize(sanitise(value), 9);
      cursor.page.drawText(sanitise(value), {
        x: right - width,
        y: cursor.y,
        size: 9,
        font: regular,
        color: colour ? rgb(...colour) : rgb(0.28, 0.33, 0.41),
      });
    });

    cursor.y -= 15;
  };

  // --- Title -----------------------------------------------------------------
  text('NEBKERN MIGRATION REPORT', { font: bold, size: 20 });
  text(job.name, { size: 12, colour: [0.39, 0.45, 0.55] });
  text(`Status: ${job.status.replace(/_/g, ' ').toUpperCase()}`, {
    font: bold,
    size: 10,
    colour: statusColour(job.status),
  });
  text(`Migration ${job.id} · generated ${new Date().toLocaleString()}`, {
    font: mono,
    size: 8,
    colour: [0.58, 0.64, 0.72],
  });

  // --- Endpoints -------------------------------------------------------------
  heading('Endpoints');
  text(`Source:      ${job.source.type === 'cloud' ? 'Supabase Cloud' : 'Self Hosted'} — ${job.source.url}`, { size: 9 });
  text(`             transport: ${job.source.transport ?? 'unknown'}`, { size: 9, colour: [0.58, 0.64, 0.72] });
  text(`Destination: ${job.destination.type === 'cloud' ? 'Supabase Cloud' : 'Self Hosted'} — ${job.destination.url}`, { size: 9 });
  text(`             transport: ${job.destination.transport ?? 'unknown'}`, { size: 9, colour: [0.58, 0.64, 0.72] });

  // --- Summary ---------------------------------------------------------------
  heading('Summary');
  row('Rows migrated', [job.stats.rowsMigrated.toLocaleString()]);
  row('Files migrated', [job.stats.filesMigrated.toLocaleString()]);
  row('Data transferred', [formatBytes(job.stats.bytesTransferred)]);
  row('Auth users migrated', [job.stats.usersMigrated.toLocaleString()]);
  row('Schema objects created', [job.stats.objectsCreated.toLocaleString()]);
  row('Errors', [job.stats.errors.toLocaleString()], job.stats.errors > 0 ? [0.86, 0.15, 0.15] : undefined);
  row('Retries', [job.stats.retries.toLocaleString()]);
  row('Skipped', [job.stats.skipped.toLocaleString()]);
  row('Duration', [formatDuration(job.elapsedMs)]);

  // --- Validation ------------------------------------------------------------
  if (job.validation) {
    heading('Validation');
    row('CHECK', ['SOURCE', 'DEST', 'RESULT']);
    cursor.y -= 2;

    for (const check of job.validation.checks) {
      row(
        check.label,
        [check.source.toLocaleString(), check.destination.toLocaleString(), check.status.toUpperCase()],
        check.status === 'fail' ? [0.86, 0.15, 0.15] : check.status === 'warn' ? [0.85, 0.47, 0.02] : [0.02, 0.59, 0.41],
      );
    }

    cursor.y -= 6;
    text(
      `${job.validation.summary.passed} passed · ${job.validation.summary.warned} warnings · ${job.validation.summary.failed} failed`,
      { font: bold, size: 9 },
    );
  }

  // --- Failures --------------------------------------------------------------
  const failed = job.tasks.filter((t) => t.status === 'failed');
  if (failed.length > 0) {
    heading(`Failed tasks (${failed.length})`);
    for (const task of failed) {
      text(`${task.stage} · ${task.label}`, { font: bold, size: 9 });
      text(truncateTo(task.error ?? 'Unknown error', 95), { size: 8, colour: [0.86, 0.15, 0.15], indent: 10 });
    }
  }

  // --- Tasks -----------------------------------------------------------------
  heading('Tasks');
  row('OBJECT', ['PROCESSED', 'TOTAL', 'STATUS']);
  cursor.y -= 2;
  for (const task of job.tasks) {
    row(`${task.stage} · ${task.label}`, [
      task.processed.toLocaleString(),
      task.total !== null ? task.total.toLocaleString() : '-',
      task.status,
    ]);
  }

  return doc.save();
}

function statusColour(status: MigrationJob['status']): [number, number, number] {
  switch (status) {
    case 'completed':
      return [0.02, 0.59, 0.41];
    case 'completed_with_errors':
      return [0.85, 0.47, 0.02];
    case 'failed':
      return [0.86, 0.15, 0.15];
    default:
      return [0.39, 0.45, 0.55];
  }
}

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on any character outside
 * it — which an em-dash or a smart quote in a table comment would be. Strip rather
 * than crash the whole report over a punctuation mark.
 */
function sanitise(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x00-\xFF]/g, '?');
}

function truncateTo(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}
