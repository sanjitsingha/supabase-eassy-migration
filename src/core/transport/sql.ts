/**
 * @file SQL literal/identifier encoding shared by every transport.
 *
 * Two of the three transports (Management API, RPC) talk to Postgres over HTTP
 * and therefore **cannot use bind parameters** — they ship a SQL string. That
 * makes correct literal encoding a safety-critical concern rather than a
 * convenience, so it lives in one file that is easy to audit.
 *
 * The encoding rules assume `standard_conforming_strings = on`, which has been
 * the Postgres default since 9.1 and is on for every Supabase instance. Under
 * that setting a backslash inside `'...'` is an ordinary character, so the only
 * metacharacter to worry about is the single quote.
 */

import { MigrationError } from '@/core/domain/errors';

/**
 * Quotes an identifier (table/column/schema name).
 *
 * Always double-quotes and doubles embedded quotes. Quoting unconditionally —
 * rather than "only when it looks like it needs it" — is what makes mixed-case
 * and reserved-word identifiers (`"user"`, `"myTable"`) survive the round trip.
 */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new MigrationError('SQL_ERROR', `Identifier contains a null byte: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a `schema.table` pair. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Quotes a string as a Postgres literal, doubling embedded single quotes. */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new MigrationError('SQL_ERROR', 'String literal contains a null byte, which Postgres text cannot store');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Dollar-quotes a large string, choosing a tag guaranteed not to occur inside it.
 *
 * Used for the multi-megabyte JSON payloads the data copier sends. Doubling quotes
 * across a 5 MB batch would be both slow and hard to eyeball in a log; dollar
 * quoting leaves the payload byte-for-byte intact.
 */
export function dollarQuote(value: string): string {
  if (value.includes('\0')) {
    throw new MigrationError('SQL_ERROR', 'Payload contains a null byte, which Postgres text cannot store');
  }
  let tag = 'nbk';
  let counter = 0;
  while (value.includes(`$${tag}$`)) {
    counter += 1;
    tag = `nbk${counter}`;
    if (counter > 1000) throw new MigrationError('SQL_ERROR', 'Unable to find a safe dollar-quote tag');
  }
  return `$${tag}$${value}$${tag}$`;
}

/**
 * Renders a JS value as a SQL literal.
 *
 * Only the shapes this codebase actually passes as parameters are handled; an
 * unrecognised shape throws rather than being coerced to something plausible.
 * Silent coercion is how data corruption starts.
 */
export function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';

  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (typeof value === 'number') {
    if (Number.isNaN(value)) return `'NaN'`;
    if (!Number.isFinite(value)) return value > 0 ? `'Infinity'` : `'-Infinity'`;
    return String(value);
  }

  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'string') {
    // Long strings are the JSON batches; dollar-quoting keeps them readable and cheap.
    return value.length > 512 ? dollarQuote(value) : quoteLiteral(value);
  }

  if (value instanceof Date) return quoteLiteral(value.toISOString());

  if (value instanceof Uint8Array) {
    // `decode(..., 'hex')` sidesteps every escape-string subtlety around bytea.
    return `decode('${Buffer.from(value).toString('hex')}', 'hex')`;
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return dollarQuote(JSON.stringify(value));
  }

  throw new MigrationError('SQL_ERROR', `Cannot encode value of type ${typeof value} as a SQL literal`);
}

/**
 * Substitutes `$1`-style placeholders with encoded literals, for the HTTP
 * transports that have no bind-parameter channel.
 *
 * The regex skips placeholders inside string literals and dollar-quoted blocks by
 * scanning the statement rather than blindly replacing — a `$1` appearing inside a
 * JSON payload must not be treated as a placeholder.
 */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  if (params.length === 0) return sql;

  let out = '';
  let i = 0;

  while (i < sql.length) {
    const char = sql[i]!;

    // Skip over single-quoted string literals verbatim.
    if (char === "'") {
      const end = findQuoteEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Skip over dollar-quoted blocks verbatim.
    const dollarTag = matchDollarTag(sql, i);
    if (dollarTag !== null) {
      const close = sql.indexOf(dollarTag, i + dollarTag.length);
      const end = close === -1 ? sql.length : close + dollarTag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // A placeholder: `$` followed by digits.
    if (char === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j]!)) j += 1;
      const index = Number.parseInt(sql.slice(i + 1, j), 10) - 1;
      if (index < 0 || index >= params.length) {
        throw new MigrationError('SQL_ERROR', `Placeholder $${index + 1} has no matching parameter`);
      }
      out += toSqlLiteral(params[index]);
      i = j;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/** Returns the index just past the closing quote of the literal starting at `start`. */
function findQuoteEnd(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2; // An escaped quote inside the literal.
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** If a dollar-quote tag opens at `pos`, returns it (e.g. `$nbk$`), else null. */
function matchDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== '$') return null;
  const match = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(sql.slice(pos));
  return match ? match[0] : null;
}
