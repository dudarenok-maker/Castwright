import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Mock fs/promises so the flush-contract test can delay writeFile and prove
   _flushPendingWritesForTests() genuinely awaits the in-flight write —
   mirrors the intercept pattern in state-io.test.ts.

   writeFilePersistentThrow (#2208 independent review, F3/round 2) mirrors
   readFileSyncPersistentThrow's shape below but for the WRITE half of
   persist — the EBUSY/EPERM OneDrive/AV case this module's own docs cite as
   the motivating scenario typically fails the WRITE, not the read.
   writeFileCallCount counts every invocation (real or faulted) the same way
   readFileSyncCallCount does. */
let writeFileImpl:
  | ((path: string, data: string, encoding: BufferEncoding) => Promise<void>)
  | null = null;
let writeFilePersistentThrow: (() => never) | null = null;
let writeFileCallCount = 0;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: (path: string, data: string, encoding: BufferEncoding): Promise<void> => {
      writeFileCallCount++;
      if (writeFilePersistentThrow) {
        writeFilePersistentThrow(); // throws — synchronous, but caught by the awaiting async caller
      }
      return (writeFileImpl ?? actual.writeFile)(path, data, encoding);
    },
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
  writeFilePersistentThrow = null;
  writeFileCallCount = 0;
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

// #2257 — "Authorize this browser" clicked twice must leave exactly one live
// self-bind record, not two. The first record is revoked (not deleted —
// matching revokeDevice's own semantics), so it's still present in the roster.
it('two consecutive createDevice(..., { selfBind: true }) calls leave exactly one non-revoked selfBind record (#2257)', async () => {
  const first = await dt.createDevice('This computer', 365, { selfBind: true });
  const second = await dt.createDevice('This computer', 365, { selfBind: true });

  const list = dt.listDevices();
  expect(list.find((d) => d.id === first.device.id)?.revoked).toBe(true);
  expect(list.find((d) => d.id === second.device.id)?.revoked).toBe(false);
  // Still present, not erased.
  expect(list.map((d) => d.id).sort()).toEqual([first.device.id, second.device.id].sort());
});

// #2257 — the marker decides, not the label. A record renamed away from
// "This computer" but still carrying selfBind:true IS revoked by the next
// self-bind; a record labelled "This computer" WITHOUT the marker is NOT.
it('a self-bind is revoked by label rename; a same-labelled non-self-bind record is left alone (#2257)', async () => {
  const renamed = await dt.createDevice('This computer', 365, { selfBind: true });
  // Simulate an operator rename: label changes, selfBind marker persists.
  const devicesRaw = JSON.parse(
    readFileSync(join(dir, 'device-tokens.json'), 'utf8'),
  ) as { devices: Record<string, unknown>[] };
  const idx = devicesRaw.devices.findIndex((d) => d.id === renamed.device.id);
  devicesRaw.devices[idx] = { ...devicesRaw.devices[idx], label: 'Mike (renamed)' };
  writeFileSync(join(dir, 'device-tokens.json'), JSON.stringify(devicesRaw), 'utf8');
  dt._resetDeviceTokenCacheForTests();

  const decoy = await dt.createDevice('This computer', 365); // no selfBind option at all
  const third = await dt.createDevice('This computer', 365, { selfBind: true });

  const list = dt.listDevices();
  // The renamed-but-still-marked record IS revoked.
  expect(list.find((d) => d.id === renamed.device.id)?.revoked).toBe(true);
  // The unmarked "This computer" decoy is NOT revoked — the label never decided.
  expect(list.find((d) => d.id === decoy.device.id)?.revoked).toBe(false);
  expect(list.find((d) => d.id === third.device.id)?.revoked).toBe(false);
});

it('createDevice without the selfBind option revokes nothing', async () => {
  const first = await dt.createDevice('This computer', 365, { selfBind: true });
  const second = await dt.createDevice('Some other device', 365);

  const list = dt.listDevices();
  expect(list.find((d) => d.id === first.device.id)?.revoked).toBe(false);
  expect(list.find((d) => d.id === second.device.id)?.revoked).toBe(false);
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

/* #2208 — recompute the quarantined set from disk inside `persist`, instead
   of trusting the snapshot captured at the last real `loadSync`. Decision
   comment on #2208: an operator who hand-repairs device-tokens.json (e.g.
   deleting a quarantined record) gets their edit picked up on the very next
   write, with no restart, no reload endpoint, and no fs.watch — the re-read
   only happens on the already-throttled write path (mint / revoke / the
   hourly `touchLastSeen`), never on the hot synchronous auth guard. */

// Test 1 — the resurrection scenario this issue is about. MUST fail on
// unmodified main: verified by running it against main before this fix
// existed (see the PR / task report for the exact failure output) — pre-fix,
// `persist` round-trips the `quarantine` snapshot captured at the ORIGINAL
// load, so the operator's hand-deletion of bad1 is silently undone by the
// very next write.
it('an operator hand-repair (deleting a quarantined record from disk) survives the next write, with no restart (#2208)', async () => {
  const badRaw = { ...goodRecord('bad1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [badRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // real load; seeds quarantine = [badRaw], populates cache
  warn.mockRestore();

  // Operator hand-repairs the file while the server keeps running: rewrite
  // it with the malformed record gone. Deliberately does NOT call
  // _resetDeviceTokenCacheForTests — a real operator can't do that either.
  writeRawStore(dir, [good]);

  // Trigger a write via the normal write path (mirrors the throttled
  // touchLastSeen the LAN guard fires).
  await dt.touchLastSeen('g1', Date.now());

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: unknown[];
  };
  expect(onDisk.devices).not.toContainEqual(badRaw);
  expect(onDisk.devices.map((d: any) => d.id)).toEqual(['g1']);
});

// Test 2 — the inverse, and the one that matters: without it, simply
// deleting the quarantine round-trip entirely (instead of recomputing it)
// would also pass test 1. If the malformed record is STILL on disk at write
// time (no hand-edit happened), it must survive verbatim, same as #2182(a)
// already pins elsewhere — asserted again here, freshly, as this fix's own
// positive control.
it('a quarantined record still present on disk at write time survives the write verbatim (#2208 positive control)', async () => {
  const badRaw = { ...goodRecord('bad1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [badRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  warn.mockRestore();

  // No external edit this time — bad1 is still on disk when the write fires.
  await dt.touchLastSeen('g1', Date.now());

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: unknown[];
  };
  expect(onDisk.devices).toContainEqual(badRaw);
});

// Test 3 — constraint 4 of the #2208 brief: `persist` already refuses to
// write while the ORIGINAL load was degraded; a failed FRESH re-read (the
// new one this fix adds) must refuse the write the same way, not silently
// fall back to a stale in-memory quarantine that might not reflect disk
// anymore. Targets specifically the re-read inside persist (not the load):
// cache is already populated by a prior real load, so loadSync() short-
// circuits and issues no readFileSync call of its own — the one-shot
// override lands exactly on persist's fresh re-read.
it('persist refuses to write (does not drop quarantine) when its fresh re-read fails, and the file is left untouched (#2208)', async () => {
  const badRaw = { ...goodRecord('bad1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [badRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // populates cache — loadSync short-circuits from here on
  warn.mockRestore();

  const before = readFileSync(join(dir, 'device-tokens.json'), 'utf8');

  readFileSyncOverride = () => {
    throw new Error('EBUSY: resource busy or locked (simulated)');
  };

  await expect(dt.touchLastSeen('g1', Date.now())).rejects.toThrow(dt.DeviceStoreDegradedError);

  const after = readFileSync(join(dir, 'device-tokens.json'), 'utf8');
  expect(after).toBe(before); // untouched: no write happened, nothing was dropped
});

// #2208 independent review, F1 — THE regression: the first cut of this fix
// only carried forward records that were STILL malformed on the fresh
// re-read. The likelier operator action, given the log line names the exact
// bad field, is to fix that field in place rather than delete the record.
// A repaired record is no longer malformed, so it was excluded from the
// malformed-only re-read — and since a quarantined id is never in `cache`,
// it was ALSO absent from `devices`. It landed in neither array and the
// write erased it, permanently, worse than doing nothing (main leaves the
// operator's repair sitting there un-erased, just un-applied). This test
// must fail on the committed 15f823a8 state and pass on unmodified `main`
// (see the task report for both outputs) — the fix broadens the rule to
// "carry forward anything on disk the live roster doesn't claim", which
// covers repair the same way it already covered deletion, with no
// special-casing.
it('an operator hand-REPAIR (fixing the bad field in place, not deleting the record) survives the next write (#2208 independent review, F1)', async () => {
  const badRaw = { ...goodRecord('bad1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [badRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // real load; bad1 quarantined, never enters cache
  warn.mockRestore();

  // Operator repairs bad1 IN PLACE on disk — same id, now a fully valid
  // record — instead of deleting it. No restart, no cache reset.
  const repairedBad1 = goodRecord('bad1', dt.hashToken('repaired-token'));
  writeRawStore(dir, [repairedBad1, good]);

  await dt.touchLastSeen('g1', Date.now());

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: Record<string, unknown>[];
  };
  // Weak assertion first, matching the reviewer's own proof shape (presence,
  // not content) — this is the one that would ALSO pass on unmodified main,
  // since main just keeps writing back whatever stale quarantine it captured
  // at load time (still containing an entry for bad1, just the OLD bytes).
  expect(onDisk.devices.map((d) => d.id)).toContain('bad1');
  // Strong assertion, specific to this fix: it's the REPAIRED record that
  // survived, not the stale malformed one main would have kept re-writing.
  expect(onDisk.devices).toContainEqual(repairedBad1);
  expect(onDisk.devices).not.toContainEqual(badRaw);
});

// Test 2 remains the positive control for the general "still-malformed and
// unclaimed survives verbatim" case (delete-repair's sibling, not touched by
// the F1 rework above since bad1 here is never touched externally).

// #2208 independent review, F2 — the "bounded by write frequency, not
// request frequency" claim only holds while persist SUCCEEDS: a failed
// persist never advances lastSeenAt, so `shouldTouchLastSeen` stays true and
// the NEXT guarded request re-fires touchLastSeen -> persist immediately.
// Without a negative-cache TTL on the fresh re-read (mirroring `loadSync`'s
// own `DEGRADED_RETRY_MS`/`degradedAt`, #2204 review F1), a persistent fault
// turns every request against a phone streaming chapter audio through
// `/workspace` into a fresh blocking disk read. Proves the negative cache
// actually blocks the amplification (not just that a retry eventually
// recovers, which a naive always-retry version would also do).
it('a persisting fresh-read fault costs at most one disk read per DEGRADED_RETRY_MS, not one per guarded request (#2208 independent review, F2)', async () => {
  const { token, device } = await dt.createDevice('Phone', 30); // populates cache; no lastSeenAt yet -> shouldTouchLastSeen is already true
  void device;

  vi.useFakeTimers();
  const start = 1_700_000_000_000;
  vi.setSystemTime(start);

  readFileSyncPersistentThrow = () => {
    throw new Error('EBUSY: resource busy or locked (simulated)');
  };
  readFileSyncCallCount = 0;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  // 5 guarded requests at effectively the same instant. Each fires a
  // fire-and-forget touchLastSeen (loadSync short-circuits on the populated
  // cache — no read there); only persist's fresh re-read touches disk.
  for (let i = 0; i < 5; i++) {
    expect(dt.isValidDeviceToken(token)).toBe(true); // auth itself is unaffected — best-effort touch only
  }
  await dt._flushPendingWritesForTests();
  warn.mockRestore();

  expect(readFileSyncCallCount).toBe(1); // exactly ONE real disk read reached the fault, not 5
});

// #2208 independent review, ROUND 2 — the F2 fix above only bounded a
// FAILING RE-READ. The scenario this module's own docs cite as the
// motivating case for the guard (EBUSY/EPERM — a OneDrive/AV lock) usually
// fails the WRITE, not the read: readUnclaimedRecordsFromDisk succeeds (the
// READ half is fine), `persistDegradedAt` (renamed from
// `freshReadDegradedAt`) resets to 0 right after that success — BEFORE the
// write is even attempted — and only then does writeJsonAtomic fail.
// Because `cache` never advances past a failed persist, shouldTouchLastSeen
// never clears, and — pre-round-2 — every guarded request re-ran the FULL
// read (bounded by nothing, since the read itself always succeeds) before
// hitting the SAME unbounded write fault. Measured independently: 20
// requests -> 20 real reads on the pre-round-2 branch, 0 extra reads on
// `main` (whose `persist` has no fresh-read step at all, so a write-only
// fault there costs 0 reads, not 20 — see the task report for the exact
// branch-vs-main probe). This test pins BOTH halves: the read count (the
// specific metric the independent review measured) and the write count
// (the fault this scenario is actually about).
it('a persisting WRITE fault costs at most one READ and one WRITE attempt per DEGRADED_RETRY_MS, not one per guarded request (#2208 independent review, round 2)', async () => {
  const { token } = await dt.createDevice('Phone', 30); // populates cache; no lastSeenAt yet -> shouldTouchLastSeen is already true

  vi.useFakeTimers();
  const start = 1_700_000_000_000;
  vi.setSystemTime(start);

  writeFilePersistentThrow = () => {
    throw new Error('EBUSY: resource busy or locked (simulated write fault)');
  };
  writeFileCallCount = 0;
  readFileSyncCallCount = 0; // the read succeeds every time it's attempted — this counts HOW OFTEN it's attempted

  // 20 guarded requests at effectively the same instant — matches the scale
  // measured in the independent review.
  for (let i = 0; i < 20; i++) {
    expect(dt.isValidDeviceToken(token)).toBe(true); // auth itself is unaffected — best-effort touch only
  }
  await dt._flushPendingWritesForTests();

  expect(readFileSyncCallCount).toBe(1); // exactly ONE real read attempt, not 20 — this is what the independent review measured
  expect(writeFileCallCount).toBe(1); // exactly ONE real write attempt reached the fault, not 20
});

// #2208 independent review, F3 — `rotate` is dropped from this file's
// `writeJsonAtomic` call (see `persist`'s own comment for the full
// rationale: a writer with no reader net-increases the chance of losing
// every pairing). This pins the negative: no `.bak.1` is ever produced.
it('does not opt device-tokens.json into writeJsonAtomic\'s rotate (#2208 independent review, F3 — rotate dropped, not fixed, for this file)', async () => {
  const { device } = await dt.createDevice('Phone', 30);
  await dt.touchLastSeen(device.id, Date.now());
  expect(existsSync(join(dir, 'device-tokens.json.bak.1'))).toBe(false);
});

// #2208 independent review, F5 — the non-array-"devices" refusal branch
// inside persist's fresh re-read was untested; only the readFileSync-throw
// branch was covered. Drives the OTHER branch: the file parses fine but its
// shape is wrong, discovered only on persist's independent re-read (cache is
// already populated, so loadSync's OWN non-array handling is not what's
// under test here).
it('a fresh re-read that finds a non-array "devices" refuses the write the same way a read throw does (#2208 independent review, F5)', async () => {
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // populates cache
  warn.mockRestore();

  // External fault: the file parses, but its shape breaks, while cache stays
  // populated (no restart) — hits persist's re-read, not loadSync's.
  const broken = JSON.stringify({ schema: 2, devices: 'oops' });
  writeFileSync(join(dir, 'device-tokens.json'), broken, 'utf8');

  await expect(dt.touchLastSeen('g1', Date.now())).rejects.toThrow(dt.DeviceStoreDegradedError);

  const after = readFileSync(join(dir, 'device-tokens.json'), 'utf8');
  expect(after).toBe(broken); // untouched — no write happened
});

// #2208 independent review, F4 — the collision guard drops a malformed disk
// record that collides with a live id, so the stale in-memory copy silently
// overwrites the operator's hand-edit. The precedence is correct (a live
// device must never lose to disk); the silence wasn't. Now warns, naming the
// id, exactly when that collision is against a MALFORMED disk record.
it('a live device corrupted on disk under the same id is written exactly once, the live copy wins, AND the operator is warned by name (#2208 independent review, F4)', async () => {
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [good]);

  const warn0 = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // real load; populates cache with the valid g1
  warn0.mockRestore();

  // Externally corrupt g1 on disk — SAME id, a different required field
  // broken — without clearing the in-memory cache (no restart).
  const corruptedG1 = { ...goodRecord('g1', 'irrelevant'), tokenHash: 123 };
  writeRawStore(dir, [corruptedG1]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await dt.touchLastSeen('g1', Date.now());
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('g1'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('tokenHash'));
  warn.mockRestore();

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: Record<string, unknown>[];
  };
  const matches = onDisk.devices.filter((d) => d.id === 'g1');
  expect(matches).toHaveLength(1); // not written twice
  expect(matches[0].tokenHash).toBe(good.tokenHash); // the live, valid copy — not the corrupted twin
});

// Positive control for the collision guard: an orphaned record (its id
// matches no live device) must still round-trip verbatim, whether it's
// malformed or — per the F1 rework — freshly valid, proving the collision
// filter narrows nothing about #2182(a)'s guarantee and can't degenerate
// into "drop all quarantine". Without this, a filter that always returns
// nothing would also make the F4 test above pass.
it('a quarantined record whose id matches no live device still round-trips verbatim (#2208 collision guard positive control)', async () => {
  const orphanRaw = { ...goodRecord('orphan1', 'irrelevant'), tokenHash: 123 };
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [orphanRaw, good]);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']);
  warn.mockRestore();

  await dt.touchLastSeen('g1', Date.now());

  const onDisk = JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8')) as {
    devices: unknown[];
  };
  expect(onDisk.devices).toContainEqual(orphanRaw);
});

// Hunted per the independent-review's requirement 3 (look for one more
// mutation no test catches): the F4 warning is gated on `invalidDeviceField`
// so it fires ONLY on a genuine malformed-disk-vs-live collision, not on the
// ordinary steady state where a live device's own unmodified, still-valid
// record is simply also present on disk under the same id (true on every
// single write for every device that hasn't been hand-edited). Dropping
// that gate — always warning on any id collision — was NOT caught by any
// existing assertion: nothing previously asserted the ABSENCE of a warning
// on an ordinary write. This locks it down.
it('an ordinary write with no hand-edit does not warn (#2208, hunted per independent-review requirement 3)', async () => {
  const good = goodRecord('g1', dt.hashToken('good-token'));
  writeRawStore(dir, [good]);
  expect(dt.listDevices().map((d) => d.id)).toEqual(['g1']); // populates cache; nothing malformed, no warnings expected

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await dt.touchLastSeen('g1', Date.now()); // ordinary write — g1's disk copy is untouched and still valid
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
