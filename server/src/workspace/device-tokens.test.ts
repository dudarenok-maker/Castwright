import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

/* One-shot override for node:fs's readFileSync — lets the transient-read-
   failure test simulate a single momentary EBUSY/EPERM without touching the
   real filesystem, then falls back to the real implementation for every
   other call (including the ones this test file itself makes).

   readFileSyncPersistentThrow is the same idea but does NOT self-clear —
   for the #2204 F1 negative-cache tests, which need the fault to keep
   failing across several loadSync attempts until the test itself clears it.
   readFileSyncCallCount counts every invocation (real or faulted) so those
   tests can assert on how many times the file was ACTUALLY touched, not
   just on the return value. */
let readFileSyncOverride: (() => never) | null = null;
let readFileSyncPersistentThrow: (() => never) | null = null;
let readFileSyncCallCount = 0;
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      readFileSyncCallCount++;
      if (readFileSyncOverride) {
        const fn = readFileSyncOverride;
        readFileSyncOverride = null; // one-shot
        return fn();
      }
      if (readFileSyncPersistentThrow) {
        return readFileSyncPersistentThrow();
      }
      return real.readFileSync(...args);
    },
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
  readFileSyncOverride = null;
  readFileSyncPersistentThrow = null;
  readFileSyncCallCount = 0;
  vi.useRealTimers(); // safety net in case a fake-timer test threw before restoring
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
// field isn't an array was silently swallowed (0 warnings). The underlying
// auth path (isValidDeviceToken) still fails closed — untouched here, see
// the F1 tests below — but #2204 review (F2/F7) changed listDevices itself:
// it now THROWS rather than silently presenting a degraded store as
// "genuinely zero devices" (200 {devices: []}). See devices.test.ts for the
// route-level 503 this becomes.
it('throws DeviceStoreDegradedError when device-tokens.json is corrupt (unparseable JSON), and warns', () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).toThrow(dt.DeviceStoreDegradedError);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[device-tokens]'));
  warn.mockRestore();
});

it('throws DeviceStoreDegradedError when device-tokens.json\'s "devices" field is not an array, and warns', () => {
  writeFileSync(join(dir, 'device-tokens.json'), JSON.stringify({ schema: 2, devices: 'oops' }), 'utf8');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).toThrow(dt.DeviceStoreDegradedError);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[device-tokens]'));
  warn.mockRestore();
});

// #2204 review (F2/F7) — the sync auth path must NOT throw: isValidDeviceToken
// still fails closed silently on a degraded store, same as before. Only the
// admin-facing reads (listDevices/revokeDevice) and the write (createDevice)
// changed to surface the degraded state as an error.
it('isValidDeviceToken still fails closed (returns false, does not throw) on a degraded store', () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.isValidDeviceToken('anything')).not.toThrow();
  expect(dt.isValidDeviceToken('anything')).toBe(false);
  warn.mockRestore();
});

// #2204 review (F2/F7) — revokeDevice used to loadSync() -> [] while
// degraded, so findIndex always returned -1 and it resolved `false` BEFORE
// ever reaching persist's own refusal; the route layer turned that into a
// 404 "Unknown device.", claiming the credential never existed when the
// truth is "can't currently read the store; that device may still be
// valid." It now throws instead of resolving false.
it('revokeDevice throws DeviceStoreDegradedError (not a false "not found") while the store is degraded', async () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(dt.revokeDevice('any-id')).rejects.toThrow(dt.DeviceStoreDegradedError);
  warn.mockRestore();
});

// #2204 review (F2/F7) — createDevice's degraded-store throw (via persist)
// was already an Error; it's now the same typed DeviceStoreDegradedError as
// revokeDevice/listDevices, so the route layer can catch all three the same
// way instead of pattern-matching on message text.
it('createDevice throws DeviceStoreDegradedError (typed, not a generic Error) while the store is degraded', async () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(dt.createDevice('Phone', 30)).rejects.toThrow(dt.DeviceStoreDegradedError);
  warn.mockRestore();
});

// #2204 review F1 — while degraded, `cache` is deliberately never populated
// (so a transient fault doesn't get remembered forever), which used to mean
// EVERY call on the hot sync auth path re-ran existsSync -> readFileSync ->
// JSON.parse. isValidDeviceToken sits directly under the LAN guard
// (requireLanToken), which fires on every /api and /workspace request — a
// phone streaming chapter audio issues hundreds of these. This proves the
// negative-cache actually blocks the amplification, not just that a retry
// eventually succeeds (a naive always-retry implementation would also
// eventually recover, so that alone wouldn't catch a regression here).
it('retries a persisting store fault at most once per DEGRADED_RETRY_MS on the hot auth path, then retries again once the window elapses (#2204 F1)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  writeRawStore(dir, [good]);

  vi.useFakeTimers();
  const start = 1_700_000_000_000;
  vi.setSystemTime(start);
  readFileSyncPersistentThrow = () => {
    throw new Error('EBUSY: resource busy or locked (simulated)');
  };
  readFileSyncCallCount = 0;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  // 5 calls at the same instant: exactly one real disk read reaches the fault.
  for (let i = 0; i < 5; i++) expect(dt.isValidDeviceToken('t1')).toBe(false);
  expect(readFileSyncCallCount).toBe(1);

  // Still inside the TTL window (500ms later, TTL is 1000ms): still no
  // second disk read, even though nothing else has changed.
  vi.setSystemTime(start + 500);
  expect(dt.isValidDeviceToken('t1')).toBe(false);
  expect(readFileSyncCallCount).toBe(1);

  // Past the TTL: retries for real. Clear the fault first so the retry can
  // actually succeed, proving self-healing rather than merely a second
  // failed attempt.
  readFileSyncPersistentThrow = null;
  vi.setSystemTime(start + 1001);
  expect(dt.isValidDeviceToken('t1')).toBe(true);
  expect(readFileSyncCallCount).toBe(2);

  warn.mockRestore();
});

// #2204 review F1 — "warn once per distinct error rather than per call".
// Spans the TTL window with fake timers so each of the three calls actually
// reaches the failing read (proving the suppression is about repeating the
// SAME error, not just the negative-cache skipping IO within one window).
it('warns once for a persisting store fault across several real retries, not once per retry (#2204 F1)', () => {
  writeFileSync(join(dir, 'device-tokens.json'), '{}', 'utf8');
  readFileSyncPersistentThrow = () => {
    throw new Error('EACCES: permission denied (simulated)');
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  vi.useFakeTimers();
  const start = 1_700_000_000_000;
  vi.setSystemTime(start);
  dt.isValidDeviceToken('x');
  vi.setSystemTime(start + 1001);
  dt.isValidDeviceToken('x');
  vi.setSystemTime(start + 2002);
  dt.isValidDeviceToken('x');

  const storeFaultWarnings = warn.mock.calls.filter((c) =>
    String(c[0]).includes('failed to read/parse'),
  );
  expect(storeFaultWarnings).toHaveLength(1);

  // A successful load in between resets the "last warned" note — so the
  // SAME error recurring after a genuine recovery warns again, rather than
  // being silenced forever by one early failure.
  readFileSyncPersistentThrow = null;
  const good = goodRecord('g1', dt.hashToken('t1'));
  writeRawStore(dir, [good]);
  dt._resetDeviceTokenCacheForTests();
  vi.setSystemTime(start + 3003);
  expect(dt.isValidDeviceToken('t1')).toBe(true); // real success, resets lastWarnedError

  readFileSyncPersistentThrow = () => {
    throw new Error('EACCES: permission denied (simulated)');
  };
  dt._resetDeviceTokenCacheForTests();
  vi.setSystemTime(start + 4004);
  dt.isValidDeviceToken('x');
  const storeFaultWarningsAfter = warn.mock.calls.filter((c) =>
    String(c[0]).includes('failed to read/parse'),
  );
  expect(storeFaultWarningsAfter).toHaveLength(2);

  warn.mockRestore();
});

// #2182 incidental finding — createDevice/revokeDevice/touchLastSeen each did
// an unsynchronised loadSync() -> mutate -> await persist(...). Confirmed
// real and 100% deterministic against pre-fix main (verified by running this
// exact assertion 5x in isolation before the enqueueWrite serialisation
// below existed: it lost the FIRST call's write every single time, because
// createDevice runs synchronously up to its first internal await, so two
// back-to-back unawaited calls both read the same stale snapshot before
// either's persist() lands). Fixed by serialising the whole read-modify-write
// behind a single promise chain (enqueueWrite), not merely the write.
it('two concurrent createDevice calls do not lose a write (unsynchronised read-modify-write race, #2182)', async () => {
  const p1 = dt.createDevice('A', 30);
  const p2 = dt.createDevice('B', 30);
  await Promise.all([p1, p2]);
  await dt._flushPendingWritesForTests();
  const labels = dt.listDevices().map((d) => d.label).sort();
  expect(labels).toEqual(['A', 'B']);
});

// #2182 (coordinator follow-up) — a shared serialisation mechanism is not
// evidence every entry point actually uses it; each write path gets its own
// deterministic lost-update regression test, mirroring createDevice's.
it('two concurrent revokeDevice calls (different devices) do not lose an update (unsynchronised read-modify-write race, #2182)', async () => {
  const { device: d1 } = await dt.createDevice('A', 30);
  const { device: d2 } = await dt.createDevice('B', 30);
  const p1 = dt.revokeDevice(d1.id);
  const p2 = dt.revokeDevice(d2.id);
  await Promise.all([p1, p2]);
  const list = dt.listDevices();
  expect(list.find((d) => d.id === d1.id)?.revoked).toBe(true);
  expect(list.find((d) => d.id === d2.id)?.revoked).toBe(true);
});

it('two concurrent touchLastSeen calls (different devices) do not lose an update (unsynchronised read-modify-write race, #2182)', async () => {
  const { device: d1 } = await dt.createDevice('A', 30);
  const { device: d2 } = await dt.createDevice('B', 30);
  const now = Date.now();
  const p1 = dt.touchLastSeen(d1.id, now);
  const p2 = dt.touchLastSeen(d2.id, now + 1);
  await Promise.all([p1, p2]);
  const list = dt.listDevices();
  expect(list.find((d) => d.id === d1.id)?.lastSeenAt).toBeDefined();
  expect(list.find((d) => d.id === d2.id)?.lastSeenAt).toBeDefined();
});

// #2183 — id is now required (a record without one can authenticate but can
// never be revoked, per revokeDevice's `d.id === id` match against an
// always-non-empty Express path param). This is the core assertion of
// #2183: it must fail before the fix (an id-less record used to authenticate
// fine, since findValidDevice never checked id).
it('drops a record with no id at all; it never authenticates (#2183)', () => {
  const bad = goodRecord('ignored', dt.hashToken('idless-token'));
  delete bad.id;
  writeRawStore(dir, [bad]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices()).toEqual([]);
  expect(dt.isValidDeviceToken('idless-token')).toBe(false);
  warn.mockRestore();
});

it('drops a record whose id is an empty string (#2183)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = { ...goodRecord('unused', dt.hashToken('empty-id-token')), id: '' };
  writeRawStore(dir, [bad, good]);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(dt.isValidDeviceToken('empty-id-token')).toBe(false);
});

// #2183 — createdAt is now strictly required (previously only validated
// when present), matching openapi.yaml's Device.required and mirroring the
// existing "missing expiresAt" drop. Must fail before the fix: a record with
// no createdAt at all used to pass invalidDeviceField unexamined.
it('drops a record with no createdAt at all (#2183)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  const bad = goodRecord('b1', dt.hashToken('bad'));
  delete bad.createdAt;
  writeRawStore(dir, [bad, good]);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
});

// #2182(a) — quarantine, not erase. The malformed record must still be on
// disk, unmodified, after a full cycle: load -> authenticate a good device
// (which fires a fire-and-forget touchLastSeen -> persist) -> "restart"
// (drop the in-memory cache and reload). It must never authenticate at any
// point. Must fail before the fix: pre-#2182 the record was simply dropped
// (filtered out) and never written back, so it vanished from disk on the
// very first persist after load.
it('quarantines a malformed record: survives authenticate + touchLastSeen + persist + restart, byte-for-byte, and never authenticates (#2182a)', async () => {
  const badRaw = { ...goodRecord('bad1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [badRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  warn.mockRestore();

  expect(dt.isValidDeviceToken('good-token')).toBe(true);
  await dt._flushPendingWritesForTests(); // the touchLastSeen this triggers -> persist

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: unknown[];
  };
  expect(onDisk.devices).toContainEqual(badRaw); // byte-for-byte: same object shape, untouched

  // "restart": drop the in-memory cache and reload from disk.
  dt._resetDeviceTokenCacheForTests();
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  expect(dt.isValidDeviceToken('irrelevant')).toBe(false);
});

// #2182(b) — a transient read failure (e.g. a momentary OneDrive/AV file
// lock, or any other one-off readFileSync throw) must cost exactly the one
// call it happened on, not poison the in-memory cache for the rest of the
// process. Must fail before the fix: pre-#2182 `catch { cache = []; }` plus
// `if (cache) return cache` meant a single transient EBUSY permanently
// emptied the roster until the process restarted. Uses fake timers to clear
// the #2204 F1 negative-cache TTL between the two calls — otherwise the
// second call would be blocked by the negative cache regardless of whether
// the underlying fault had cleared, which is exactly what the F1 tests
// above pin down separately.
it('a transient read failure does not persist past the next loadSync once the negative-cache TTL elapses (#2182b)', () => {
  const good = goodRecord('g1', dt.hashToken('t1'));
  writeRawStore(dir, [good]);

  vi.useFakeTimers();
  const start = 1_700_000_000_000;
  vi.setSystemTime(start);

  readFileSyncOverride = () => {
    throw new Error('EBUSY: resource busy or locked, open ' + join(dir, 'device-tokens.json'));
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).toThrow(dt.DeviceStoreDegradedError); // degraded: this ONE call sees nothing
  warn.mockRestore();

  // The override was one-shot; once the negative-cache TTL elapses, the
  // NEXT loadSync retries the file for real and succeeds.
  vi.setSystemTime(start + 1001);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
});

// #2182(b) — the flip side: while degraded, persist must REFUSE rather than
// write, so a corrupt store plus a createDevice can't clobber every existing
// pairing with a one-device file. Must fail before the fix: pre-#2182,
// createDevice would happily loadSync() -> [] (fail-closed read), push the
// new record, and persist() a fresh one-device file over the corrupt one —
// destroying whatever devices were actually still described in that file.
it('refuses to write while the last load was degraded (corrupt store); the corrupt file is left intact and an error surfaces (#2182b)', async () => {
  const corrupt = '{ this is not json';
  writeFileSync(join(dir, 'device-tokens.json'), corrupt, 'utf8');

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(dt.createDevice('Phone', 30)).rejects.toThrow(dt.DeviceStoreDegradedError);
  warn.mockRestore();

  const onDisk = readFileSync(join(dir, 'device-tokens.json'), 'utf8');
  expect(onDisk).toBe(corrupt); // untouched — not overwritten with a one-device file
});

// #2182 (coordinator follow-up) — _resetDeviceTokenCacheForTests must reset
// ALL module state it owns (cache, quarantine, loadDegraded), not just
// cache, so it's a genuinely clean slate for the next load. Sequence: seed
// quarantine with a real dropped record from an original workspace state,
// drive a whole-store degraded load, reset, then load a genuinely different
// clean store and mint a device. Assert (a) the clean load is not treated as
// still-degraded (createDevice succeeds rather than refusing) and (b) the
// original workspace's stale quarantined record does not resurface on disk.
//
// IMPORTANT — this test does NOT prove the fix. I verified this directly: I
// reverted _resetDeviceTokenCacheForTests to its old one-line form
// (`cache = null;` only, no quarantine/loadDegraded reset) and re-ran this
// test in isolation. It still passed. Why: setting `cache = null` alone is
// enough to force the next `loadSync()` call to do a real disk read instead
// of taking the `if (cache) return cache;` fast path, and EVERY branch of
// `loadSync()` that runs on a real read (success, no-file, corrupt-JSON,
// non-array-devices) unconditionally reassigns both `quarantine` and
// `loadDegraded` from the file it just read — none of them read or trust
// the incoming (possibly stale) value. Every call site of `persist()`
// (`createDevice`/`revokeDevice`/`touchLastSeen`) calls `loadSync()`
// synchronously, in the same operation, immediately beforehand, so by the
// time `persist()` runs, both variables are already fresh and correct
// regardless of what the reset hook did or didn't clear a moment earlier.
// This test is kept because it still pins a real, useful invariant (reset
// produces a genuinely clean slate) and would catch a DIFFERENT future
// regression — e.g. a `loadSync` branch that starts conditionally trusting
// a stale `quarantine`/`loadDegraded` instead of always recomputing it. Do
// not read this test passing as proof that the three-line reset hook is
// doing anything over the one-line version; it isn't, today.
it('_resetDeviceTokenCacheForTests resets cache, quarantine, and loadDegraded — a degraded load followed by reset then a clean load starts genuinely clean', async () => {
  const staleBad = { ...goodRecord('stale-bad', 'irrelevant'), tokenHash: 123 };
  const firstGood = goodRecord('first-good', dt.hashToken('first-token'));
  writeRawStore(dir, [staleBad, firstGood]);
  const warn1 = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['first-good']); // seeds quarantine = [staleBad]
  warn1.mockRestore();

  // Drive a whole-store degraded load (must reset first to force a re-read).
  dt._resetDeviceTokenCacheForTests();
  writeFileSync(join(dir, 'device-tokens.json'), '{ this is not json', 'utf8');
  const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => dt.listDevices()).toThrow(dt.DeviceStoreDegradedError); // degraded
  warn2.mockRestore();

  // The hook under test.
  dt._resetDeviceTokenCacheForTests();

  // A genuinely different, clean store — no trace of staleBad.
  const secondGood = goodRecord('second-good', dt.hashToken('second-token'));
  writeRawStore(dir, [secondGood]);

  const { device } = await dt.createDevice('New', 30); // must NOT refuse as still-degraded
  expect(device.id).toBeTruthy();

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: Record<string, unknown>[];
  };
  expect(onDisk.devices.map((d) => d.id)).not.toContain('stale-bad');
});
