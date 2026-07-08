import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Mock fs/promises so the flush-contract test can delay writeFile and prove
   _flushPendingWritesForTests() genuinely awaits the in-flight write —
   mirrors the intercept pattern in state-io.test.ts. */
let writeFileImpl:
  | ((path: string, data: string, encoding: BufferEncoding) => Promise<void>)
  | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: (path: string, data: string, encoding: BufferEncoding): Promise<void> =>
      (writeFileImpl ?? actual.writeFile)(path, data, encoding),
  };
});

let dir: string;
let dt: typeof import('./device-tokens.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-devtok-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();                       // re-read WORKSPACE_ROOT at module load
  dt = await import('./device-tokens.js');
});
afterEach(async () => {
  writeFileImpl = null;
  delete process.env.WORKSPACE_DIR;
  // Flush any fire-and-forget touchLastSeen write isValidDeviceToken kicked
  // off before wiping the workspace — otherwise the in-flight write can race
  // the recursive rm and intermittently fail with ENOTEMPTY (same race
  // devices.test.ts hit).
  await dt._flushPendingWritesForTests();
  rmSync(dir, { recursive: true, force: true });
});

it('shouldTouchLastSeen is throttled (pure)', async () => {
  const now = 1_000_000_000_000;
  const fresh = { id: '1', label: 'P', tokenHash: 'h', createdAt: '', lastSeenAt: new Date(now - 1000).toISOString() };
  const stale = { ...fresh, lastSeenAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() };
  const never = { id: '1', label: 'P', tokenHash: 'h', createdAt: '' };
  expect(dt.shouldTouchLastSeen(fresh, now)).toBe(false);
  expect(dt.shouldTouchLastSeen(stale, now)).toBe(true);
  expect(dt.shouldTouchLastSeen(never, now)).toBe(true);
});

it('touchLastSeen persists lastSeenAt; isValidDeviceToken triggers it', async () => {
  const { device } = await dt.createDevice('Phone', 30);
  await dt.touchLastSeen(device.id, Date.now());      // awaitable → deterministic
  dt._resetDeviceTokenCacheForTests();
  expect(dt.listDevices()[0].lastSeenAt).toBeDefined();

  const { token } = await dt.createDevice('Phone2', 30);
  expect(dt.isValidDeviceToken(token)).toBe(true);     // fire-and-forget touch path still returns true
});

it('_flushPendingWritesForTests waits for an in-flight touchLastSeen write before resolving', async () => {
  const { token } = await dt.createDevice('Phone', 30);

  let releaseWrite: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  writeFileImpl = async (path, data, encoding) => {
    await gate;
    await actual.writeFile(path, data, encoding);
  };

  expect(dt.isValidDeviceToken(token)).toBe(true); // fresh device -> fires the (now-gated) write

  let flushed = false;
  const flush = dt._flushPendingWritesForTests().then(() => { flushed = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(flushed).toBe(false); // the write is still gated — flush must not resolve early

  releaseWrite();
  await flush;
  expect(flushed).toBe(true);
});
