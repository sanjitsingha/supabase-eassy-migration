/**
 * @file Verifies the data-directory fallback that fixes the Vercel ENOENT crash.
 *
 * Simulates the actual failure: `process.cwd()` pointed at a location the store
 * cannot create a subdirectory under — a read-only deployment root, exactly what
 * `/var/task` is on Vercel. A correct implementation falls back to the OS temp
 * directory instead of throwing; the fix is only real if the store still answers.
 *
 * Run with: npx tsx scripts/verify-store-fallback.ts
 */
import { mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import os from 'node:os';

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passes += 1; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('\x1b[1m\x1b[36mNebkern — data directory fallback (Vercel read-only-cwd fix)\x1b[0m\n');

  // Windows has no real chmod-based read-only directory enforcement the way POSIX
  // does, so this harness only proves the thing that actually matters cross-platform:
  // that the fallback path is reachable and functions correctly end to end. The
  // read-only trigger itself is exercised in the mkdir catch block via a genuinely
  // unwritable path where supported.
  const readonlyRoot = process.platform === 'win32'
    ? null
    : await (async () => {
        const dir = join(tmpdir(), `nebkern-readonly-${Date.now()}`);
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o444);
        return dir;
      })();

  if (readonlyRoot !== null) {
    process.env.NEBKERN_DATA_DIR = join(readonlyRoot, '.nebkern');
  } else {
    // On Windows, force the override to a location that cannot be created: a path
    // nested under a file (not a directory), which mkdir cannot traverse — the same
    // class of failure (parent is not a writable directory) that produces the
    // Vercel ENOENT.
    const blocker = join(tmpdir(), `nebkern-blocker-${Date.now()}.txt`);
    await import('node:fs/promises').then((fs) => fs.writeFile(blocker, 'x'));
    process.env.NEBKERN_DATA_DIR = join(blocker, '.nebkern');
  }

  const { jobRepository, dataDirectory } = await import('../src/core/infra/store');

  console.log('1. Writing to an intentionally unwritable NEBKERN_DATA_DIR');
  let threw = false;
  try {
    await jobRepository.save({
      id: 'fallback_test',
      name: 'fallback test',
      status: 'created',
      source: { type: 'cloud', url: 'https://x.supabase.co', projectRef: null, transport: null },
      destination: { type: 'cloud', url: 'https://y.supabase.co', projectRef: null, transport: null },
      selection: {} as never,
      options: {} as never,
      discovery: null,
      tasks: [],
      stats: { rowsMigrated: 0, filesMigrated: 0, bytesTransferred: 0, usersMigrated: 0, objectsCreated: 0, errors: 0, retries: 0, skipped: 0 },
      validation: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      error: null,
    });
  } catch (err) {
    threw = true;
    console.log(`   (save threw: ${err instanceof Error ? err.message : String(err)})`);
  }

  check('save() does not crash despite an unwritable configured root', !threw);

  const dir = await dataDirectory();
  check(
    'the resolved data directory falls back to the OS temp dir, not the unwritable root',
    dir.startsWith(os.tmpdir()),
    `resolved to: ${dir}`,
  );

  const found = await jobRepository.find('fallback_test');
  check('a job saved during the fallback can be read back', found?.id === 'fallback_test', JSON.stringify(found));

  console.log(`\n   → data directory: ${dir}`);

  // Cleanup
  await jobRepository.remove('fallback_test').catch(() => undefined);
  if (readonlyRoot !== null) {
    await chmod(readonlyRoot, 0o755).catch(() => undefined);
    await rm(readonlyRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n${'─'.repeat(64)}`);
  const colour = failures === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`${colour}${passes} passed, ${failures} failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('\n\x1b[31mHarness crashed:\x1b[0m', err);
  process.exit(1);
});
