/**
 * @file Inspects a Supabase API key locally, before any network call.
 *
 * This exists to catch the single most common setup mistake — **pasting the anon key
 * where the service role key belongs** — at the moment of typing, rather than three
 * minutes into a migration when a `SELECT` on `auth.users` mysteriously returns zero
 * rows. An anon key authenticates perfectly happily; it just sees almost nothing,
 * because RLS is doing its job. Failing loudly here is far kinder than succeeding
 * quietly there.
 *
 * We decode, we do not *verify*. Verification would need the project's JWT secret,
 * which we neither have nor want. The payload's claims are enough to tell whether the
 * user grabbed the wrong key, and the server will reject a forged one anyway.
 */

import type { KeyInspection } from '@/core/domain/types';

/** Legacy Supabase keys are JWTs; the newer ones (`sb_secret_…`) are opaque strings. */
export function inspectKey(key: string): KeyInspection {
  const token = key.trim();
  const errors: string[] = [];
  const warnings: string[] = [];

  const empty: KeyInspection = {
    role: null,
    ref: null,
    expiresAt: null,
    expired: false,
    opaque: false,
    errors,
    warnings,
  };

  if (token === '') {
    return { ...empty, errors: ['A service role key is required.'] };
  }

  // New-style keys carry no claims to read. Recognise them rather than reporting
  // "not a valid JWT", which would be true but useless.
  if (token.startsWith('sb_secret_')) {
    return { ...empty, opaque: true };
  }
  if (token.startsWith('sb_publishable_')) {
    return {
      ...empty,
      opaque: true,
      errors: ['This is a publishable key. A migration needs the secret key (sb_secret_…).'],
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      ...empty,
      errors: ['This does not look like a Supabase key. Expected a JWT (eyJ…) or a secret key (sb_secret_…).'],
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = decodeSegment(parts[1] ?? '');
  } catch {
    return { ...empty, errors: ['The key is malformed and could not be decoded.'] };
  }

  const role = typeof payload.role === 'string' ? payload.role : null;
  const ref = typeof payload.ref === 'string' ? payload.ref : null;

  const expSeconds = typeof payload.exp === 'number' ? payload.exp : null;
  const expiresAt = expSeconds !== null ? new Date(expSeconds * 1000).toISOString() : null;
  const expired = expSeconds !== null && expSeconds * 1000 < Date.now();

  if (role === 'anon') {
    errors.push(
      'This is the anon key. It is subject to row-level security, so a migration would silently read almost nothing. Use the service role key.',
    );
  } else if (role !== null && role !== 'service_role') {
    warnings.push(`This key carries the role "${role}" rather than "service_role". It may not have full access.`);
  } else if (role === null) {
    warnings.push('The key has no role claim, so its privileges could not be confirmed.');
  }

  if (expired) {
    errors.push(`This key expired on ${new Date(expiresAt ?? '').toLocaleDateString()}.`);
  }

  return { role, ref, expiresAt, expired, opaque: false, errors, warnings };
}

/**
 * Decodes one base64url JWT segment.
 *
 * Isomorphic on purpose: the form validates the key as you type (in the browser) and
 * the server validates it again on submit. `Buffer` does not exist in a browser bundle
 * and `atob` does not exist in older Node, so we use whichever is present rather than
 * shipping a polyfill for a fifteen-line function.
 */
function decodeSegment(segment: string): Record<string, unknown> {
  // base64url → base64, then pad to a multiple of 4.
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  let json: string;
  if (typeof atob === 'function') {
    // `atob` yields a binary string; reinterpret it as UTF-8 so non-ASCII claims survive.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } else {
    json = Buffer.from(padded, 'base64').toString('utf8');
  }

  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Payload is not an object');
  return parsed as Record<string, unknown>;
}
