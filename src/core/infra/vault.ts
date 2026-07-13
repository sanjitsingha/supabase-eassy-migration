/**
 * @file In-memory credential vault.
 *
 * The security requirement is "never store the service role key permanently;
 * encrypt in memory; auto-clear". This is what that means in practice, and what
 * it honestly does and does not buy you:
 *
 * - Credentials live **only** in this process's heap. Nothing is written to disk,
 *   nothing goes into the job file, nothing is logged. Kill the process and the
 *   secrets are gone — which is why resuming a job after a server restart asks
 *   for the keys again rather than silently having kept them around.
 * - At rest in the heap they are AES-256-GCM encrypted under a key generated at
 *   process start. This defends against the realistic threat: a heap dump, a core
 *   file, or an accidental `console.log(vault)` leaking plaintext keys. It does
 *   *not* defend against code running in this process, which can simply call
 *   `get()` — no in-process scheme can, and claiming otherwise would be theatre.
 * - Entries auto-expire and are zeroed after {@link VAULT_TTL_MS}.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SupabaseCredentials } from '@/core/domain/types';
import { MigrationError } from '@/core/domain/errors';
import { VAULT_TTL_MS } from '@/core/domain/constants';

const ALGORITHM = 'aes-256-gcm';

interface VaultEntry {
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
  expiresAt: number;
}

/**
 * Per-process encryption key. Deliberately *not* derived from an env var or any
 * persisted material: a new key each boot means yesterday's heap dump is
 * undecryptable today, and there is no long-lived secret to leak.
 */
const MASTER_KEY = randomBytes(32);

/** Keyed by `${jobId}:${role}`. */
const store = new Map<string, VaultEntry>();

function keyFor(jobId: string, role: 'source' | 'destination'): string {
  return `${jobId}:${role}`;
}

function encrypt(plaintext: string): Omit<VaultEntry, 'expiresAt'> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

function decrypt(entry: VaultEntry): string {
  const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, entry.iv);
  decipher.setAuthTag(entry.authTag);
  return Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString('utf8');
}

/** Overwrite a buffer's bytes before dropping the reference. */
function wipe(entry: VaultEntry): void {
  entry.ciphertext.fill(0);
  entry.iv.fill(0);
  entry.authTag.fill(0);
}

export const credentialVault = {
  /** Encrypts and stores one endpoint's credentials, replacing any existing entry. */
  put(jobId: string, role: 'source' | 'destination', creds: SupabaseCredentials): void {
    const k = keyFor(jobId, role);
    const existing = store.get(k);
    if (existing) wipe(existing);
    store.set(k, { ...encrypt(JSON.stringify(creds)), expiresAt: Date.now() + VAULT_TTL_MS });
  },

  /**
   * Decrypts and returns credentials.
   *
   * @throws {MigrationError} `CREDENTIALS_EXPIRED` when absent or past TTL — the
   * signal the UI uses to re-prompt for keys before resuming a job.
   */
  get(jobId: string, role: 'source' | 'destination'): SupabaseCredentials {
    const k = keyFor(jobId, role);
    const entry = store.get(k);
    if (!entry) {
      throw new MigrationError(
        'CREDENTIALS_EXPIRED',
        `No ${role} credentials held for this migration. They are never persisted to disk, so re-enter them to continue.`,
      );
    }
    if (Date.now() > entry.expiresAt) {
      wipe(entry);
      store.delete(k);
      throw new MigrationError(
        'CREDENTIALS_EXPIRED',
        `The ${role} credentials for this migration expired and were cleared. Re-enter them to continue.`,
      );
    }
    return JSON.parse(decrypt(entry)) as SupabaseCredentials;
  },

  has(jobId: string, role: 'source' | 'destination'): boolean {
    const entry = store.get(keyFor(jobId, role));
    return entry !== undefined && Date.now() <= entry.expiresAt;
  },

  /** Slides the TTL forward. Called on each checkpoint so long migrations don't expire mid-run. */
  touch(jobId: string): void {
    for (const role of ['source', 'destination'] as const) {
      const entry = store.get(keyFor(jobId, role));
      if (entry) entry.expiresAt = Date.now() + VAULT_TTL_MS;
    }
  },

  /** Zeroes and removes both endpoints' credentials. Called when a job reaches a terminal state. */
  clear(jobId: string): void {
    for (const role of ['source', 'destination'] as const) {
      const k = keyFor(jobId, role);
      const entry = store.get(k);
      if (entry) {
        wipe(entry);
        store.delete(k);
      }
    }
  },

  /** Removes every expired entry. Driven by the sweeper below. */
  sweep(): number {
    const now = Date.now();
    let cleared = 0;
    for (const [k, entry] of store) {
      if (now > entry.expiresAt) {
        wipe(entry);
        store.delete(k);
        cleared += 1;
      }
    }
    return cleared;
  },

  /** Diagnostics for the Settings page. Reveals counts and expiry only — never secrets. */
  inspect(): readonly { readonly jobId: string; readonly role: string; readonly expiresInMs: number }[] {
    const now = Date.now();
    return [...store.entries()].map(([k, entry]) => {
      const sep = k.lastIndexOf(':');
      return {
        jobId: k.slice(0, sep),
        role: k.slice(sep + 1),
        expiresInMs: Math.max(0, entry.expiresAt - now),
      };
    });
  },
} as const;

// Sweep every minute. `unref` so this timer never keeps the process alive.
const sweeper = setInterval(() => void credentialVault.sweep(), 60_000);
if (typeof sweeper.unref === 'function') sweeper.unref();
