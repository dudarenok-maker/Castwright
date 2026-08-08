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
 *  it, and it never enters `cache`, so it can never authenticate.
 *
 *  Was a known gap, now closed by #2208, and hardened by that PR's own
 *  independent review: `loadSync` still only recomputes this variable on a
 *  real disk read and still short-circuits on a populated `cache` — but
 *  `persist` no longer trusts this possibly-stale snapshot for what to write
 *  back. It re-derives, immediately before every write, the full set of
 *  on-disk records the live roster does NOT claim (`readUnclaimedRecordsFromDisk`,
 *  below) — not just the still-malformed ones — and reassigns this variable
 *  from that fresh result. That single rule is what makes a hand-DELETE of a
 *  quarantined record, a hand-REPAIR of one (fixing the bad field in place
 *  rather than removing the record), and a restore from a hand-copied backup
 *  all survive the next write the same way, with no special-casing: a
 *  narrower first cut that only re-derived the still-malformed subset made
 *  the repair case WORSE than doing nothing — it erased the operator's fix
 *  outright, because a now-valid record is absent from both the stale
 *  `cache` and the malformed-only re-read. The extra read is bounded by
 *  write frequency — mint, revoke, and the hourly-throttled touch — never by
 *  request frequency (see `persistDegradedAt` below); the synchronous auth
 *  guard (`isValidDeviceToken`) never calls `persist` and is unaffected. */
let quarantine: unknown[] = [];

/** True when the most recent `loadSync` hit a whole-store fault (corrupt
 *  JSON, or a non-array "devices") rather than a per-record one. #2182(b):
 *  while this is true, `cache` is deliberately left `null` (so the *next*
 *  `loadSync` retries the file instead of the failure being cached for the
 *  rest of the process), and `persist` refuses to write — see there. */
let loadDegraded = false;

/** Wall-clock time (ms) of the most recent failed load attempt; 0 when not
 *  degraded. Backs the negative-cache TTL below (#2204 review, F1). */
let degradedAt = 0;

/** #2204 review (F1) — while degraded, `cache` is deliberately never
 *  populated (see `loadDegraded` above), which used to mean every single
 *  call re-ran `existsSync` -> `readFileSync` -> `JSON.parse` and emitted a
 *  fresh `console.warn`. `loadSync` sits under the SYNCHRONOUS LAN-auth
 *  guard (`isValidDeviceToken`), which fires on every `/api` and
 *  `/workspace` request — a phone streaming chapter audio issues hundreds
 *  of these, so a degraded store meant blocking disk IO plus a log line on
 *  the hot path, per request, unbounded, for as long as the store stayed
 *  unreadable. This caps the actual retry to at most once per
 *  `DEGRADED_RETRY_MS`: a call within the window short-circuits to `[]`
 *  without touching disk, preserving the "don't cache the failure forever"
 *  intent (a transient lock still clears within a second or two) while
 *  removing the per-request amplification. */
const DEGRADED_RETRY_MS = 1000;

/** The message most recently warned about, so a persisting failure warns
 *  once (the first time it's seen) rather than on every call that hits it
 *  — see `warnOnce` below. Reset to `null` on any successful load. */
let lastWarnedError: string | null = null;

function warnOnce(message: string): void {
  if (lastWarnedError === message) return;
  lastWarnedError = message;
  console.warn(message);
}

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
  // #2204 review (F1) — while degraded, `cache` stays null by design (see
  // `loadDegraded`'s doc comment), so without this short-circuit every call
  // on the hot auth path would re-run the disk read below. Retry at most
  // once per DEGRADED_RETRY_MS instead; a transient lock still clears
  // within a second or two, and a genuinely broken store just stays [].
  if (loadDegraded && Date.now() - degradedAt < DEGRADED_RETRY_MS) return [];
  const path = deviceTokensJsonPath();
  if (!existsSync(path)) {
    loadDegraded = false;
    quarantine = [];
    lastWarnedError = null;
    return (cache = []);
  }
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown };
    if (!Array.isArray(f.devices)) {
      warnOnce(`[device-tokens] ${path} has no valid "devices" array — treating as empty for this call (0 devices will authenticate); will retry after ${DEGRADED_RETRY_MS}ms rather than on every call`);
      // #2182(b) — do NOT populate `cache`: a whole-store fault must not be
      // remembered as "this workspace has 0 devices" for the rest of the
      // process. Leave the door open for a later loadSync to retry (gated
      // by the TTL above, not every call — #2204 review F1).
      loadDegraded = true;
      degradedAt = Date.now();
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
      // revocable, otherwise-valid device for a display fault. Deliberate
      // trade-off, not an oversight (#2204 review F5): the coerced value is
      // what `persist` round-trips on the next write, overwriting the
      // original malformed label on disk — unlike `quarantine` six lines
      // up, which keeps a dropped record's bytes verbatim. A label is
      // display-only, so losing the exact original garbage costs nothing an
      // operator would need to recover.
      if (typeof r.label !== 'string' || r.label.length === 0) {
        console.warn(`[device-tokens] device record "${r.id}" has an invalid label — coercing to "Unnamed device"`);
        survivors.push({ ...r, label: 'Unnamed device' });
      } else {
        survivors.push(r);
      }
    });
    quarantine = dropped;
    loadDegraded = false;
    lastWarnedError = null;
    cache = survivors;
  } catch (err) {
    warnOnce(
      `[device-tokens] failed to read/parse ${path}: ${err instanceof Error ? err.message : String(err)} — treating as empty for this call (0 devices will authenticate); will retry after ${DEGRADED_RETRY_MS}ms rather than on every call`,
    );
    // #2182(b) — same reasoning as the non-array-devices branch above: don't
    // cache a transient failure (e.g. a momentary OneDrive/AV file lock).
    loadDegraded = true;
    degradedAt = Date.now();
    return [];
  }
  return cache;
}

/** Thrown by `persist`, `revokeDevice`, `listDevices`, and (transitively,
 *  via `persist`) `createDevice` when the device store is currently
 *  degraded (#2204 review F2/F7) — the last load hit a whole-store fault
 *  (corrupt JSON, or a non-array "devices") rather than a per-record one.
 *  Callers (the route layer) should answer 503 with `.message` rather than
 *  letting this reach the generic `errorHandler` 500, and rather than
 *  treating `loadSync`'s fail-closed `[]` as "genuinely zero devices" —
 *  the difference between "no devices" and "can't currently read the
 *  devices" matters most for `revokeDevice` (an unreadable store must not
 *  report "Unknown device" for one that may still be valid and
 *  authenticating) and `listDevices` (must not report an empty roster as
 *  if it were authoritative). */
export class DeviceStoreDegradedError extends Error {
  constructor() {
    super(
      `[device-tokens] ${deviceTokensJsonPath()} could not be read (corrupt file or an invalid "devices" array) — existing devices are unaffected and will keep authenticating; fix or remove the file, then retry.`,
    );
    this.name = 'DeviceStoreDegradedError';
  }
}

/** Sentinel returned by `readUnclaimedRecordsFromDisk` on a whole-store
 *  fault (missing/corrupt JSON, or a non-array "devices"), distinct from a
 *  legitimate empty array (nothing unclaimed on disk right now, or no file
 *  yet). Kept as its own symbol rather than `null` so a future refactor
 *  can't accidentally coerce it into an empty-array quarantine. */
const QUARANTINE_READ_DEGRADED = Symbol('quarantine-read-degraded');

/** Extract a raw record's `id` IF it's a genuine, non-empty string — the one
 *  thing safe to trust about an `unknown` record without running it through
 *  `invalidDeviceField` first. Returns `null` for anything else (missing,
 *  non-string, or a non-object record), which callers must treat as "can
 *  never collide with a live id". */
function rawRecordId(d: unknown): string | null {
  return d !== null && typeof d === 'object' && typeof (d as Record<string, unknown>).id === 'string'
    ? ((d as Record<string, unknown>).id as string)
    : null;
}

/** Re-read `device-tokens.json` fresh off disk and return every raw record
 *  currently there whose `id` the live roster (`liveDevices`, i.e. `devices`
 *  as `persist` is about to write it) does NOT claim — without going
 *  through `loadSync`'s `cache` short-circuit and without touching `cache`,
 *  `loadDegraded`, or `quarantine` itself (that's the caller's job — see
 *  `persist`, #2208).
 *
 *  #2208 independent review, F1 (the fix that actually matters here): the
 *  first cut of this function only carried forward records that were STILL
 *  malformed, mirroring what `loadSync` itself would quarantine. That is
 *  wrong for the operator action the log line most directly invites: fixing
 *  the bad field IN PLACE rather than deleting the record. A repaired
 *  record is no longer malformed, so the malformed-only filter dropped it —
 *  and because a quarantined id is never in `cache`, it was ALSO absent from
 *  `devices`, so it landed in neither array and the write erased it. Worse
 *  than doing nothing at all: the operator's fix was destroyed instead of
 *  merely not yet honoured. The SAME hole erased a restore from a
 *  hand-copied `.bak.N` file. The correct invariant is broader and needs no
 *  per-scenario special-casing: a write must never drop a record that is on
 *  disk and that the live roster does not claim — full stop, whether that
 *  record is malformed, freshly repaired, or anything else. So this
 *  function no longer calls `invalidDeviceField` to decide what to keep; it
 *  keeps everything not claimed by `liveDevices`.
 *
 *  The collision case (an id IS claimed by `liveDevices`) still needs a
 *  decision, for the reason the original cut of this fix introduced: a
 *  record that was valid at the last `loadSync` and has since been
 *  corrupted on disk under the SAME id would otherwise be written twice —
 *  once as the live survivor in `devices`, once as a raw disk record here.
 *  The live, in-memory value wins (never the inverse — a live device is
 *  never dropped in favour of what's on disk), matching the precedence
 *  `loadSync`'s own label coercion already gives the in-memory value over
 *  malformed disk bytes (`:241-246`). #2208 independent review, F4: that
 *  precedence used to be silent. It now warns, naming the id and the field
 *  — but ONLY when the colliding disk record is actually malformed
 *  (`invalidDeviceField` is used here, purely to decide whether to warn, not
 *  whether to keep): the ordinary steady state is a live device whose
 *  unmodified, still-valid record is simply also present on disk under the
 *  same id — that's not a loss (`devices` already carries it and is about to
 *  rewrite it), and warning on it would fire on every single write. */
function readUnclaimedRecordsFromDisk(
  liveDevices: readonly DeviceTokenRecord[],
): unknown[] | typeof QUARANTINE_READ_DEGRADED {
  const path = deviceTokensJsonPath();
  if (!existsSync(path)) return [];
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown };
    if (!Array.isArray(f.devices)) return QUARANTINE_READ_DEGRADED;
    const liveIds = new Set(liveDevices.map((d) => d.id));
    const unclaimed: unknown[] = [];
    for (const d of f.devices) {
      const rawId = rawRecordId(d);
      if (rawId !== null && liveIds.has(rawId)) {
        const field = invalidDeviceField(d);
        if (field !== null) {
          console.warn(
            `[device-tokens] disk record "${rawId}" is malformed (invalid ${field}) but that id is still live in memory — keeping the live copy, the disk edit was NOT written`,
          );
        }
        continue; // claimed by a live device — never carried forward, live wins either way
      }
      unclaimed.push(d); // not claimed by anything live: could be still-malformed, freshly repaired, or orphaned — kept verbatim regardless
    }
    return unclaimed;
  } catch {
    return QUARANTINE_READ_DEGRADED;
  }
}

/** Wall-clock time (ms) of the most recent FAILED `persist` attempt — either
 *  half of it: the fresh re-read, OR the actual `writeJsonAtomic` write; 0
 *  when the last attempt succeeded (or none has run yet). Backs the
 *  negative-cache TTL `persist` applies to itself — see there. #2208
 *  independent review, F2: mirrors `degradedAt`'s shape exactly (same
 *  `DEGRADED_RETRY_MS` window, same "0 means not degraded" convention)
 *  rather than inventing a second mechanism.
 *
 *  Second independent-review pass: originally named `freshReadDegradedAt`
 *  and set ONLY on a failed re-read. That missed the exact scenario this
 *  module's own docs cite as the motivating case for the guard —
 *  EBUSY/EPERM from a OneDrive/AV lock — because that fault typically hits
 *  the WRITE, not the read: `readUnclaimedRecordsFromDisk` succeeds, this
 *  variable resets to 0, and only THEN does `writeJsonAtomic` fail. `cache`
 *  never advances past a failed persist (see this function's final two
 *  lines), so `shouldTouchLastSeen` stays permanently true and every
 *  guarded request re-fires `touchLastSeen` -> `persist`, each one
 *  repeating the FULL read again (bounded fine) but then hitting the SAME
 *  unbounded write fault on every single request — measured 20 requests ->
 *  20 real `writeJsonAtomic` attempts against unmodified persist, 0 against
 *  `main` (which has no fresh-read/write step in `persist` at all). Renamed
 *  and now set on EITHER failure so one guard bounds both. */
let persistDegradedAt = 0;

async function persist(devices: DeviceTokenRecord[]): Promise<void> {
  // #2182(b) — refuse to write while the last load was degraded: the
  // alternative is minting/revoking/touching a device into a file that now
  // contains ONLY that write, destroying every other pairing on the box.
  if (loadDegraded) {
    throw new DeviceStoreDegradedError();
  }
  // #2208 independent review — the "bounded by write frequency, not request
  // frequency" claim only holds while persist SUCCEEDS: a successful
  // persist is what advances `cache`'s lastSeenAt and so is what stops
  // `shouldTouchLastSeen` firing again. A persist that throws — for EITHER
  // reason `persistDegradedAt` covers, see its own doc comment — leaves
  // `lastSeenAt` exactly where it was, so the NEXT guarded request re-fires
  // `touchLastSeen` -> `enqueueWrite` -> `persist` immediately — and without
  // this check, each of those would re-attempt whichever real disk
  // operation just failed, turning a persistent fault (EBUSY/EPERM — the
  // OneDrive/AV case `state-io.ts` documents) into one blocking disk
  // operation per request for as long as the fault lasts. That is the exact
  // per-request amplification #2204's review (F1) closed for `loadSync`,
  // reopened one level down — same fix, same shape: retry the real
  // operation at most once per `DEGRADED_RETRY_MS`, refuse immediately on
  // every attempt inside the window.
  if (persistDegradedAt !== 0 && Date.now() - persistDegradedAt < DEGRADED_RETRY_MS) {
    throw new DeviceStoreDegradedError();
  }
  // #2208 — recompute the on-disk-but-unclaimed set RIGHT NOW rather than
  // reusing the (possibly stale) `quarantine` snapshot from the last real
  // `loadSync`, so an operator's hand-edit is picked up on the very next
  // write instead of being silently undone by it (see
  // `readUnclaimedRecordsFromDisk`'s own header for the full rule and why
  // it must not special-case delete vs. repair vs. restore). A failed
  // re-read must not become a write that drops records the last successful
  // load knew about — refuse exactly like the `loadDegraded` check above
  // rather than falling back to the stale in-memory value, which would
  // either resurrect nothing (if it was empty) or write back records that
  // may no longer reflect what's actually on disk.
  const unclaimed = readUnclaimedRecordsFromDisk(devices);
  if (unclaimed === QUARANTINE_READ_DEGRADED) {
    persistDegradedAt = Date.now();
    throw new DeviceStoreDegradedError();
  }
  quarantine = unclaimed;
  // #2182(a) / #2208 — round-trip every on-disk record the live roster
  // doesn't claim, verbatim, alongside the (possibly mutated) survivors, so
  // none of them is ever erased by an ordinary write.
  //
  // #2208 independent review, F3 — `rotate` was considered for this write
  // and DROPPED. `writeJsonAtomic`'s rotate option (see `state-io.ts`)
  // finishes its pre-write step by renaming the live file to `.bak.1` —
  // there is a real window, between that rename and the new file landing,
  // where `device-tokens.json` does not exist at all. `state.json` pairs
  // that same option with a reader, `readJsonWithRecovery`, which falls
  // back to `.bak.N` on a corrupt read; this file has no such reader. So a
  // write that failed after the rotate step (ENOSPC, EACCES, a process
  // death) would leave NO live file — `loadSync` would then see a missing
  // file and report `cache = []` with no warning, an authoritative-looking
  // "zero paired devices" — strictly worse than `main`'s behaviour with no
  // rotate at all (a failed write there leaves the previous file untouched).
  // A safe version of this — rotating by copy instead of rename so the live
  // file is never absent, or giving `loadSync` its own synchronous `.bak.N`
  // fallback — is a real decision with its own design and test surface, not
  // a same-diff addition; left for a follow-up rather than shipped as a
  // writer with no reader.
  //
  // #2208 independent review, second pass — the write itself is wrapped so a
  // WRITE fault (not just the fresh-read fault above) also sets
  // `persistDegradedAt`, closing the amplification described in that
  // variable's doc comment. The original error is rethrown UNCHANGED (not
  // wrapped in `DeviceStoreDegradedError`) — callers already handle whatever
  // `writeJsonAtomic` throws today, and reclassifying a write-specific
  // failure as the read-oriented `DeviceStoreDegradedError` message ("could
  // not be read...") would be actively misleading; only the RETRY RATE
  // needed fixing here, not the error's shape.
  try {
    await writeJsonAtomic(deviceTokensJsonPath(), { schema: 2, devices: [...devices, ...quarantine] });
  } catch (err) {
    persistDegradedAt = Date.now();
    throw err;
  }
  persistDegradedAt = 0; // only after a FULLY successful persist — read AND write both landed
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
 *  carries the rejection.
 *
 *  Re-entrancy warning (#2204 review F6), same discipline CLAUDE.md already
 *  states for `withCastLock`: a function running INSIDE `enqueueWrite` must
 *  never call another function that itself calls `enqueueWrite` — the inner
 *  call's `.then` would be queued behind the outer call's own still-pending
 *  turn on `writeChain`, which can only settle once the outer call returns,
 *  which it can't do until the inner call (that it's awaiting) resolves.
 *  Permanent deadlock, no timeout, no diagnostic. `createDevice`,
 *  `revokeDevice`, and `touchLastSeen` are each a single, non-nesting
 *  `enqueueWrite` call today — keep it that way. */
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

/** Revoke a device by id. Returns false if no such device.
 *  Throws `DeviceStoreDegradedError` if the store is currently unreadable
 *  (#2204 review F2/F7) — before this, a degraded `loadSync()` returned
 *  `[]`, so `findIndex` always came back `-1` and this returned `false`
 *  BEFORE ever reaching `persist`'s own refusal, and the route layer turned
 *  that into a 404 "Unknown device." — reporting a credential as
 *  never-having-existed when the truth is "I can't read the store; that
 *  device is still valid and will authenticate again shortly." Checking
 *  `loadDegraded` explicitly, rather than relying on `persist` to surface
 *  it, matters because this function returns before ever calling
 *  `persist` in the not-found case. */
export async function revokeDevice(id: string): Promise<boolean> {
  return enqueueWrite(async () => {
    const devices = loadSync();
    if (loadDegraded) throw new DeviceStoreDegradedError();
    const idx = devices.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    const next = devices.map((d, i) => (i === idx ? { ...d, revoked: true } : d));
    await persist(next);
    return true;
  });
}

/** Throws `DeviceStoreDegradedError` if the store is currently unreadable
 *  (#2204 review F2/F7) — before this, a degraded `loadSync()` silently
 *  returned `[]` and this presented that as `200 {devices: []}`, an
 *  authoritative-looking empty roster indistinguishable from "genuinely no
 *  paired devices". */
export function listDevices(): PublicDevice[] {
  const devices = loadSync();
  if (loadDegraded) throw new DeviceStoreDegradedError();
  return devices.map(redactDevice);
}

/** Test hook — clears the in-memory cache so a fresh workspace is re-read.
 *  Resets the LOAD-path module state this file owns (`cache`, `quarantine`,
 *  `loadDegraded`, `degradedAt`, `lastWarnedError`), not just `cache`: a
 *  reset hook that only clears part of its own module's state leaves a
 *  stale `quarantine`/`loadDegraded` behind for whatever `loadSync` call
 *  happens next. Not exploitable today — every `loadSync` branch that
 *  clears `loadDegraded` also reassigns `quarantine`, and `persist` refuses
 *  to write while degraded — but a reset hook whose whole purpose is test
 *  isolation should not depend on that invariant holding in every future
 *  edit to stay correct.
 *
 *  Also resets `persistDegradedAt` (#2208 independent review): a process
 *  restart clears that negative-cache timer along with everything else in
 *  this module, and a mid-test "restart" via this hook should mean the
 *  same thing.
 *
 *  Deliberately does NOT reset `writeChain`/`pendingWrites` (#2204 review
 *  F8, correcting an earlier version of this comment that overclaimed
 *  "resets ALL module state this file owns"): those are WRITE-path state
 *  with their own lifecycle — `writeChain` is a promise chain that always
 *  resolves to a fresh no-op link after each call (see `enqueueWrite`), and
 *  `pendingWrites` empties itself as each tracked write settles — so
 *  neither one accumulates anything a reset needs to clear between test
 *  cases.
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
  degradedAt = 0;
  lastWarnedError = null;
  persistDegradedAt = 0;
}

/** Test hook — await every fire-and-forget `touchLastSeen` write kicked off
 *  by `isValidDeviceToken`, so a temp-workspace teardown (recursive rm) run
 *  right after doesn't race an in-flight write and intermittently fail with
 *  ENOTEMPTY. */
export async function _flushPendingWritesForTests(): Promise<void> {
  await Promise.all(pendingWrites);
}
