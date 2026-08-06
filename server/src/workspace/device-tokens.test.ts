import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// #2149 (issue comment, second instance from the #2144 review) — a garbage
// lastSeenAt gives Date.parse -> NaN, `now - NaN` is NaN, and `NaN > threshold`
// is false, so the throttled touch never fires and "last seen" freezes
// permanently. Decision: treat a malformed lastSeenAt the same as an absent
// one (touch now) rather than leaving it frozen forever, since the record has
// already survived load-time validation on the fields that matter for auth.
it('shouldTouchLastSeen treats a malformed lastSeenAt as absent (touch now), not frozen forever', () => {
  const now = 1_000_000_000_000;
  const garbage = { id: '1', label: 'P', tokenHash: 'h', createdAt: '', lastSeenAt: 'garbage' };
  expect(dt.shouldTouchLastSeen(garbage, now)).toBe(true);
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

/* #2149 — loadSync validation. Every field the auth path trusts is checked
   at load; a record that fails any check is dropped (never reaches an
   authentication decision) and a warning names the record and the field.
   Of the options considered — refuse to start, repair in place, drop
   silently, drop with a warning — this repo chose "drop with a warning":
   refusing to start lets one bad byte brick the whole install; repairing in
   place would silently re-issue an expiry the operator never granted;
   dropping silently leaves no trace an operator could act on. See #2149. */

function writeRawStore(dirPath: string, devices: unknown[]): void {
  writeFileSync(join(dirPath, 'device-tokens.json'), JSON.stringify({ schema: 2, devices }), 'utf8');
}

function goodRecord(id: string, tokenHash: string): Record<string, unknown> {
  return {
    id,
    label: 'Phone',
    tokenHash,
    createdAt: new Date(1_000_000_000_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

it('drops a record with a non-string tokenHash, keeps good records, and warns naming the record + field', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('b1', 'irrelevant'), tokenHash: 123 };
  writeRawStore(dir, [bad, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('b1'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('tokenHash'));
  warn.mockRestore();
});

it('drops a record with an empty-string tokenHash', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('b1', ''), tokenHash: '' };
  writeRawStore(dir, [bad, good]);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
});

it('drops a record whose expiresAt is unparseable garbage', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('b1', dt.hashToken('bad')), expiresAt: 'garbage' };
  writeRawStore(dir, [bad, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('expiresAt'));
  warn.mockRestore();
});

it('drops a record whose expiresAt is missing (legacy schema-1 fails closed at load, mirroring #2144 at auth time)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = goodRecord('b1', dt.hashToken('bad'));
  delete bad.expiresAt;
  writeRawStore(dir, [bad, good]);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
});

it('drops a record whose revoked field is present but not a boolean', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('b1', dt.hashToken('bad')), revoked: 'false' };
  writeRawStore(dir, [bad, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('revoked'));
  warn.mockRestore();
});

it('drops a record whose createdAt is present but unparseable', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('b1', dt.hashToken('bad')), createdAt: 'garbage' };
  writeRawStore(dir, [bad, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('createdAt'));
  warn.mockRestore();
});

it('drops a record that is not an object at all (null, a string, a number, an array element)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  writeRawStore(dir, [null, 'oops', 42, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(warn).toHaveBeenCalledTimes(3);
  // Not just "called 3 times" — each of the 3 non-object shapes must be
  // named as an invalid *record*, not just counted (a narrowed `raw === null`
  // check would still call warn 3 times for these inputs, via the tokenHash
  // guard one line down, without ever naming the "record" shape itself).
  for (const call of warn.mock.calls) {
    expect(call[0]).toEqual(expect.stringContaining('invalid record'));
  }
  warn.mockRestore();
});

it('a store with one malformed record and three good records authenticates the three (load-time drop, order-independent)', async () => {
  const t1 = 'raw-token-1';
  const t2 = 'raw-token-2';
  const t3 = 'raw-token-3';
  const good1 = goodRecord('g1', dt.hashToken(t1));
  const good2 = goodRecord('g2', dt.hashToken(t2));
  const good3 = goodRecord('g3', dt.hashToken(t3));
  const bad = { ...goodRecord('bad', 'x'), tokenHash: null };
  writeRawStore(dir, [good1, bad, good2, bad, good3]);

  // The malformed records must be gone at LOAD time, not merely unmatched by
  // findValidDevice's own tokenHash guard — otherwise this test is satisfied
  // by defence-in-depth alone and never exercises loadSync's validation.
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1', 'g2', 'g3']);

  expect(dt.isValidDeviceToken(t1)).toBe(true);
  expect(dt.isValidDeviceToken(t2)).toBe(true);
  expect(dt.isValidDeviceToken(t3)).toBe(true);
  await dt._flushPendingWritesForTests();
});

it('a wholly malformed store does not throw, does not prevent startup, and authenticates nobody', () => {
  writeRawStore(dir, [
    null,
    { id: 'a', tokenHash: 42 },
    { id: 'b', tokenHash: 'h', expiresAt: 'garbage' },
    { id: 'c', tokenHash: 'h', expiresAt: new Date().toISOString(), revoked: 'nope' },
  ]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).not.toThrow();
  expect(dt.listDevices()).toEqual([]);
  expect(dt.isValidDeviceToken('anything')).toBe(false);
  warn.mockRestore();
});

// #2181 review — a corrupt/unparseable store or a store whose "devices"
// field isn't an array was silently swallowed (0 warnings). Fail-closed
// behaviour (cache = []) is unchanged and NOT under test here — only that
// the operator now gets a log line naming what went wrong.
it('warns when device-tokens.json is corrupt (unparseable JSON), and still fails closed', () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).not.toThrow();
  expect(dt.listDevices()).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[device-tokens]'));
  warn.mockRestore();
});

it('warns when device-tokens.json\'s "devices" field is not an array, and still fails closed', () => {
  writeFileSync(join(dir, 'device-tokens.json'), JSON.stringify({ schema: 2, devices: 'oops' }), 'utf8');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).not.toThrow();
  expect(dt.listDevices()).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[device-tokens]'));
  warn.mockRestore();
});
