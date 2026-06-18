import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let dt: typeof import('./device-tokens.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-devtok-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();                       // re-read WORKSPACE_ROOT at module load
  dt = await import('./device-tokens.js');
});
afterEach(async () => {
  // Drain pending microtasks so fire-and-forget persists from isValidDeviceToken
  // complete before the temp dir is removed, avoiding an unhandled ENOENT rejection.
  await new Promise((r) => setTimeout(r, 0));
  delete process.env.WORKSPACE_DIR;
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
