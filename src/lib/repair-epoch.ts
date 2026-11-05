/* #3713 / PR #4004 (owner decision after pass 5) — the client half of the server's repaired-id write gate
   (server/src/workspace/repaired-book-gate.ts).

   From a duplicate-bookId repair until the repaired book is deleted (no expiry) the server refuses every book-content write that names a
   repaired id, with 409 `book_repaired_reload`, unless the request carries `X-Repair-Epoch` equal to the
   current repair epoch. This page reads that epoch ONCE, from `GET /api/info`, when it loads
   (`loadRepairEpoch`, called by main.tsx), and `repairFetch` sends it on every write. It is never
   refreshed: a page loaded before a repair must not learn the new epoch from a later poll.

   The answer to a refusal is a full page reload, which discards every slice, cache, queue and modal the
   page holds, so nothing stale survives it and nothing on this side decides what is stale. A series
   fan-out (or a design start) that would write a repaired series-mate is refused whole by the same 409, so
   it reloads the same way and the repeat carries the epoch. Nothing is shown: once the reload is decided, every request this module would send is held, so no second write goes out
   and no caller toasts or retries. A reload loop (a server bug, a clock jump) is capped by a
   sessionStorage counter; past the cap the page shows a blocking notice instead
   (`components/repair-reload-blocked.tsx`). */

const REPAIR_EPOCH_HEADER = 'X-Repair-Epoch';
export const BOOK_REPAIRED_RELOAD = 'book_repaired_reload';

/** At most this many automatic reloads per window, per tab. One is the legitimate case. */
const MAX_RELOADS = 2;
const RELOAD_WINDOW_MS = 5 * 60_000;
const RELOADS_KEY = 'castwright.repairReloads';

let epoch: Promise<string | null> | null = null;
/** The epoch once its read has settled (undefined while it is out), so a write need not wait a tick for it. */
let settled: string | null | undefined;
let reloading = false;
let blocked = false;
const listeners = new Set<() => void>();

/** Read the epoch this page was loaded under. Once; a later call is a no-op. A failed read leaves the page with
 *  none, which the server refuses only while a repaired id is gated (the reload then reads it afresh). */
export function loadRepairEpoch(): void {
  if (epoch) return;
  epoch = globalThis
    .fetch('/api/info')
    .then((res) => (res.ok ? (res.json() as Promise<{ repairEpoch?: unknown }>) : null))
    .then((body) => (typeof body?.repairEpoch === 'string' && body.repairEpoch !== '' ? body.repairEpoch : null))
    .catch(() => null)
    .then((value) => (settled = value));
}

/** True once the reload cap was reached: the blocking notice is up and no write is sent. */
export function isRepairReloadBlocked(): boolean {
  return blocked;
}

export function subscribeRepairReloadBlocked(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function __resetRepairEpochForTest(): void {
  epoch = null;
  settled = undefined;
  reloading = false;
  blocked = false;
  listeners.clear();
}

function recentReloads(now: number): number[] | null {
  try {
    const raw = sessionStorage.getItem(RELOADS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((t): t is number => typeof t === 'number' && now - t < RELOAD_WINDOW_MS) : [];
  } catch {
    return null;
  }
}

function recordReload(list: number[]): boolean {
  try {
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** This page predates a repair: reload it, once. Past the cap, or with no storage to count reloads in (a loop
 *  could not be stopped), block instead. */
export function reloadForRepair(): void {
  if (reloading || blocked) return;
  const now = Date.now();
  const recent = recentReloads(now);
  if (recent === null || recent.length >= MAX_RELOADS || !recordReload([...recent, now])) {
    blocked = true;
    for (const l of listeners) l();
    return;
  }
  reloading = true;
  window.location.reload();
}

/** A request that never settles: what every caller sees once the reload is decided. */
const held = (): Promise<Response> => new Promise<Response>(() => {});

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
}

/** `fetch` plus the epoch on every write, and the reload on a refusal. A read is sent untouched. */
export const repairFetch: typeof fetch = async (input, init) => {
  if (reloading) return held();
  const method = methodOf(input, init);
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && blocked) return held();
  let sent = init;
  if (isWrite) {
    /* Never loaded (a unit test, mock mode): none. Still out: wait for it, so a write made early still carries it. */
    const current = epoch === null ? null : settled !== undefined ? settled : await epoch;
    if (current) {
      const headers = new Headers(init?.headers);
      headers.set(REPAIR_EPOCH_HEADER, current);
      sent = { ...init, headers };
    }
  }
  if (reloading) return held();
  const res = await (sent === undefined ? globalThis.fetch(input) : globalThis.fetch(input, sent));
  if (isWrite && res.status === 409 && typeof res.clone === 'function') {
    try {
      const body = (await res.clone().json()) as { code?: unknown };
      if (body?.code === BOOK_REPAIRED_RELOAD) {
        reloadForRepair();
        return held();
      }
    } catch {
      /* not JSON: an ordinary 409 */
    }
  }
  return res;
};
