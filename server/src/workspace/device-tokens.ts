/* srv-33 (plan 188) — per-device access tokens for the companion, layered on
   srv-20's shared-secret guard.

   srv-20 enables LAN auth via a single shared secret (LAN_AUTH_TOKEN). srv-33
   adds individually-revocable per-device tokens that the guard ALSO accepts —
   so you can hand a token to a phone and later revoke just that phone without
   rotating the shared secret for every device. Backward-compatible: the shared
   secret keeps working unchanged.

   Storage: one workspace-level JSON file (device-tokens.json). We persist only
   the SHA-256 of each token (never the raw token — minted once, shown once).
   An in-memory cache keeps the guard SYNCHRONOUS (no async middleware), loaded
   lazily and refreshed on every mutation. */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { deviceTokensJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';

export interface DeviceTokenRecord {
  id: string;
  label: string;
  /** SHA-256 hex of the raw token. The raw token is never stored. */
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;        // ISO; absent (legacy schema-1) OR unparseable → rejected (#2144)
  lastSeenAt?: string;
  revoked?: boolean;
}

/** Device record minus the secret hash — safe to return from the API. */
export interface PublicDevice {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  lastSeenAt?: string;
  revoked: boolean;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Find the non-revoked, non-expired device whose token hash matches `rawToken`,
 *  comparing hashes with a timing-safe equal. Pure — no IO. */
export function findValidDevice(
  devices: readonly DeviceTokenRecord[],
  rawToken: string,
  now: number = Date.now(),
): DeviceTokenRecord | null {
  const h = Buffer.from(hashToken(rawToken));
  for (const d of devices) {
    if (d.revoked) continue;
    const exp = d.expiresAt === undefined ? NaN : Date.parse(d.expiresAt);
    if (!Number.isFinite(exp) || now > exp) continue;
    // #2149 — defence-in-depth, mirroring the expiresAt guard above.
    // loadSync validates tokenHash before a record ever reaches `cache`, so
    // this should be unreachable in practice — but Buffer.from throws a
    // TypeError on a non-string, and this loop is the SYNCHRONOUS auth
    // guard: an unguarded throw here wouldn't just fail this one record, it
    // would abort matching for every record after it (a live availability
    // defect, not just hardening — see #2149). Decision: make this call
    // throw-safe too, so any future path that populates `devices` without
    // going through loadSync can't reintroduce the bug.
    if (typeof d.tokenHash !== 'string') continue;
    const dh = Buffer.from(d.tokenHash);
    if (dh.length === h.length && timingSafeEqual(dh, h)) return d;
  }
  return null;
}

export function redactDevice(d: DeviceTokenRecord): PublicDevice {
  return {
    id: d.id,
    label: d.label,
    createdAt: d.createdAt,
    ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
    ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
    revoked: d.revoked === true,
  };
}

/** Clamp a configured TTL to a sane positive integer; fall back to the 30-day default. */
export function clampTtlDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 30;
}

/* --- IO + in-memory cache ------------------------------------------------- */

let cache: DeviceTokenRecord[] | null = null;

/** Raw (unvalidated) records dropped by the most recent successful load,
 *  kept verbatim so `persist` can round-trip them. #2182(a): a malformed
 *  per-record fault is quarantined, not erased — it is written back to disk
 *  untouched on every subsequent persist, so an operator can always recover
 *  it, and it never enters `cache`, so it can never authenticate. */
let quarantine: unknown[] = [];

/** True when the most recent `loadSync` hit a whole-store fault (corrupt
 *  JSON, or a non-array "devices") rather than a per-record one. #2182(b):
 *  while this is true, `cache` is deliberately left `null` (so the *next*
 *  `loadSync` retries the file instead of the failure being cached for the
 *  rest of the process), and `persist` refuses to write — see there. */
let loadDegraded = false;

/** Validate a raw parsed device record against every field the auth path
 *  trusts (#2149, widened by #2183). Returns the name of the first field
 *  that failed, or `null` if the record is trustworthy.
 *
 *  Of the options considered — refuse to start, repair in place, drop
 *  silently, drop with a warning — this repo chose "drop with a warning":
 *  refusing to start lets one bad field brick the whole install; repairing
 *  in place (e.g. re-deriving expiresAt from createdAt + ttlDays) would
 *  silently re-issue an expiry the operator never granted; dropping
 *  silently leaves no trace an operator could act on. A record that fails
 *  any check here is dropped by `loadSync` (quarantined, with a warning)
 *  and never reaches an authentication decision. See #2149 for the
 *  original decision and #2183 for `id`/`createdAt` being added to it.
 *
 *  `label` is deliberately NOT checked here — #2183 chose coercion over
 *  drop for a bad label (a display fault, not a security/lifecycle one);
 *  see the coercion step in `loadSync` below. */
function invalidDeviceField(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'record';
  const r = raw as Record<string, unknown>;
  // #2183 — revocability is the one capability a per-device token exists to
  // provide; an id-less record can authenticate but can never be revoked
  // (revokeDevice matches on `d.id === id` against a always-non-empty path
  // param, so `undefined === '<anything>'` is permanently false). Required
  // non-empty string, same posture as tokenHash below.
  if (typeof r.id !== 'string' || r.id.length === 0) return 'id';
  if (typeof r.tokenHash !== 'string' || r.tokenHash.length === 0) return 'tokenHash';
  // Mirrors findValidDevice's own #2144 formula — absent (legacy schema-1)
  // and unparseable are both untrustworthy, the same rule that already
  // rejects the record at auth time, applied one step earlier at load time.
  const exp = r.expiresAt === undefined ? NaN : Date.parse(r.expiresAt as string);
  if (!Number.isFinite(exp)) return 'expiresAt';
  if (r.revoked !== undefined && typeof r.revoked !== 'boolean') return 'revoked';
  // #2183 — createdAt is non-optional in DeviceTokenRecord and required by
  // openapi.yaml's Device schema, so it is now STRICTLY required rather than
  // validated-only-when-present: an absent createdAt fails this check too
  // (typeof undefined !== 'string'), same fatality tier as a missing
  // expiresAt already gets.
  if (typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) return 'createdAt';
  return null;
}

function loadSync(): DeviceTokenRecord[] {
  if (cache) return cache;
  const path = deviceTokensJsonPath();
  if (!existsSync(path)) {
    loadDegraded = false;
    quarantine = [];
    return (cache = []);
  }
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown };
    if (!Array.isArray(f.devices)) {
      console.warn(`[device-tokens] ${path} has no valid "devices" array — treating as empty for this call (0 devices will authenticate); will retry on the next load rather than caching the failure`);
      // #2182(b) — do NOT populate `cache`: a whole-store fault must not be
      // remembered as "this workspace has 0 devices" for the rest of the
      // process. Leave the door open for the next loadSync to retry.
      loadDegraded = true;
      return [];
    }
    const survivors: DeviceTokenRecord[] = [];
    const dropped: unknown[] = [];
    f.devices.forEach((d: unknown, i: number) => {
      const field = invalidDeviceField(d);
      if (field !== null) {
        const id =
          d !== null && typeof d === 'object' && typeof (d as Record<string, unknown>).id === 'string'
            ? (d as Record<string, unknown>).id
            : `index ${i}`;
        console.warn(`[device-tokens] quarantining malformed device record "${id}": invalid ${field} (kept on disk, never authenticates)`);
        dropped.push(d);
        return;
      }
      const r = d as DeviceTokenRecord;
      // #2183 — a bad label is coerced, not dropped: don't punish a
      // revocable, otherwise-valid device for a display fault.
      if (typeof r.label !== 'string' || r.label.length === 0) {
        console.warn(`[device-tokens] device record "${r.id}" has an invalid label — coercing to "Unnamed device"`);
        survivors.push({ ...r, label: 'Unnamed device' });
      } else {
        survivors.push(r);
      }
    });
    quarantine = dropped;
    loadDegraded = false;
    cache = survivors;
  } catch (err) {
    console.warn(
      `[device-tokens] failed to read/parse ${path}: ${err instanceof Error ? err.message : String(err)} — treating as empty for this call (0 devices will authenticate); will retry on the next load rather than caching the failure`,
    );
    // #2182(b) — same reasoning as the non-array-devices branch above: don't
    // cache a transient failure (e.g. a momentary OneDrive/AV file lock).
    loadDegraded = true;
    return [];
  }
  return cache;
}

async function persist(devices: DeviceTokenRecord[]): Promise<void> {
  // #2182(b) — refuse to write while the last load was degraded: the
  // alternative is minting/revoking/touching a device into a file that now
  // contains ONLY that write, destroying every other pairing on the box.
  if (loadDegraded) {
    throw new Error(
      `[device-tokens] refusing to write ${deviceTokensJsonPath()}: the last load attempt failed (corrupt file or an invalid "devices" array) — fix or remove the file, then retry.`,
    );
  }
  // #2182(a) — round-trip the quarantined records untouched alongside the
  // (possibly mutated) survivors, so a malformed record is never erased by
  // an ordinary write.
  await writeJsonAtomic(deviceTokensJsonPath(), { schema: 2, devices: [...devices, ...quarantine] });
  cache = devices; // only after the write durably succeeds
}

/** Serialises the read-modify-write critical section shared by
 *  `createDevice` / `revokeDevice` / `touchLastSeen`. #2182 incidental
 *  finding: each of those did an unsynchronised `loadSync()` -> mutate ->
 *  `await persist(...)`; two concurrent callers could both read the same
 *  pre-mutation snapshot and have the second write silently clobber the
 *  first (confirmed real and deterministic — see the regression test).
 *  A single module-level chain queues the ENTIRE operation (not just the
 *  write), so a queued caller's `loadSync()` only runs once every
 *  earlier-queued write (including its `cache` update) has settled. A
 *  rejection must not wedge the chain for later callers, so the
 *  chain-continuation swallows it — only the caller's own returned promise
 *  carries the rejection. */
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const LASTSEEN_THROTTLE_MS = 60 * 60 * 1000; // ~1h — bounds disk writes on the hot guard path

/** Pure: has it been long enough since lastSeenAt to be worth a write?
 *  #2149 — a malformed lastSeenAt (Date.parse -> NaN) is treated the same
 *  as an absent one (touch now), not left frozen forever: `now - NaN` is
 *  NaN, and NaN compared against the threshold is always false, so an
 *  unguarded parse would silently and permanently stop touching the
 *  record. The record has already survived load-time validation on the
 *  fields that matter for auth, so treating a bad lastSeenAt as "never
 *  seen" is the safe reading here. */
export function shouldTouchLastSeen(record: DeviceTokenRecord, now: number): boolean {
  const parsed = record.lastSeenAt ? Date.parse(record.lastSeenAt) : NaN;
  const last = Number.isFinite(parsed) ? parsed : 0;
  return now - last > LASTSEEN_THROTTLE_MS;
}

/** Awaitable: stamp lastSeenAt for one device and persist. */
export async function touchLastSeen(id: string, now: number): Promise<void> {
  await enqueueWrite(async () => {
    const next = loadSync().map((d) =>
      d.id === id ? { ...d, lastSeenAt: new Date(now).toISOString() } : d,
    );
    await persist(next);
  });
}

/** Tracks in-flight fire-and-forget `touchLastSeen` writes so tests can await
 *  them all — see `_flushPendingWritesForTests`. A Set (not a single slot)
 *  so a second touch fired before the first settles isn't dropped. */
const pendingWrites = new Set<Promise<unknown>>();

/** Sync token check used by the LAN guard (cache-backed). */
export function isValidDeviceToken(rawToken: string): boolean {
  const now = Date.now();
  const device = findValidDevice(loadSync(), rawToken, now);
  if (!device) return false;
  // Best-effort touch — must not throw on the sync guard path; swallow any rejection.
  if (shouldTouchLastSeen(device, now)) {
    const write = touchLastSeen(device.id, now).catch(() => {});
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  }
  return true;
}

/** Mint a new per-device token. Returns the raw token ONCE (only its hash is
 *  stored); callers must surface it to the user immediately. */
export async function createDevice(
  label: string,
  ttlDays: number,
): Promise<{ device: PublicDevice; token: string }> {
  return enqueueWrite(async () => {
    const devices = [...loadSync()];
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const record: DeviceTokenRecord = {
      id: randomBytes(8).toString('hex'),
      label: label.trim().slice(0, 64) || 'Device',
      tokenHash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
    };
    devices.push(record);
    await persist(devices);
    return { device: redactDevice(record), token };
  });
}

/** Revoke a device by id. Returns false if no such device. */
export async function revokeDevice(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const devices = loadSync();
    const idx = devices.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    const next = devices.map((d, i) => (i === idx ? { ...d, revoked: true } : d));
    await persist(next);
    return true;
  });
}

export function listDevices(): PublicDevice[] {
  return loadSync().map(redactDevice);
}

/** Test hook — clears the in-memory cache so a fresh workspace is re-read.
 *  Resets ALL module state this file owns (`cache`, `quarantine`,
 *  `loadDegraded`), not just `cache`: a reset hook that only clears part of
 *  its own module's state leaves a stale `quarantine`/`loadDegraded` behind
 *  for whatever `loadSync` call happens next. Not exploitable today — every
 *  `loadSync` branch that clears `loadDegraded` also reassigns `quarantine`,
 *  and `persist` refuses to write while degraded — but a reset hook whose
 *  whole purpose is test isolation should not depend on that invariant
 *  holding in every future edit to stay correct.
 *
 *  This is defensive completeness, not a fix for an observed failure: no
 *  test can currently distinguish this from the old cache-only version (see
 *  the reset-hook test in device-tokens.test.ts for why, and for the actual
 *  verification that it doesn't). It becomes load-bearing the moment any
 *  `loadSync` branch stops unconditionally overwriting `quarantine`/
 *  `loadDegraded` from the file it just read — e.g. a future branch that
 *  reuses a prior value instead of recomputing it. At that point this reset
 *  starts mattering, silently, with no test currently in place to catch a
 *  regression in it. */
export function _resetDeviceTokenCacheForTests(): void {
  cache = null;
  quarantine = [];
  loadDegraded = false;
}

/** Test hook — await every fire-and-forget `touchLastSeen` write kicked off
 *  by `isValidDeviceToken`, so a temp-workspace teardown (recursive rm) run
 *  right after doesn't race an in-flight write and intermittently fail with
 *  ENOTEMPTY. */
export async function _flushPendingWritesForTests(): Promise<void> {
  await Promise.all(pendingWrites);
}
