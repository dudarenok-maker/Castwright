/* #3713 / PR #4004 (owner decision after pass 5) — the client half of the blunt repaired-id gate: the epoch is
   read once at page load and sent on every write; a `book_repaired_reload` refusal reloads
   the page exactly once and nothing more is sent; a reload loop is capped by a sessionStorage counter. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetRepairEpochForTest,
  isRepairReloadBlocked,
  loadRepairEpoch,
  reloadForRepair,
  repairFetch,
  subscribeRepairReloadBlocked,
} from './repair-epoch';

type Call = { url: string; method: string; epoch: string | null };

const REFUSED = () =>
  new Response(JSON.stringify({ error: 'repaired', code: 'book_repaired_reload' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });

let calls: Call[];
let reload: ReturnType<typeof vi.fn>;
let infoEpoch: string | null;
let respond: (url: string, method: string) => Response | Promise<Response>;

function stubServer(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/api/info') return new Response(JSON.stringify({ repairEpoch: infoEpoch }), { status: 200 });
    calls.push({ url, method, epoch: new Headers(init?.headers).get('x-repair-epoch') });
    return respond(url, method);
  });
}

/** Lets every pending microtask and short timer run. */
const flush = () => new Promise((r) => setTimeout(r, 0));
const settles = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await flush();
  await flush();
  return done;
};

beforeEach(() => {
  __resetRepairEpochForTest();
  sessionStorage.clear();
  calls = [];
  infoEpoch = 'epoch-A';
  respond = () => new Response('{}', { status: 200 });
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  stubServer();
});
afterEach(() => vi.unstubAllGlobals());

describe('the page-load repair epoch (#3713)', () => {
  it('every write carries the epoch read at load; a read carries none', async () => {
    loadRepairEpoch();
    await repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    await repairFetch('/api/library-cast/override', { method: 'POST', body: '{}' });
    await repairFetch('/api/books/b', { method: 'DELETE' });
    await repairFetch('/api/books/b/state');
    expect(calls.map((c) => [c.method, c.epoch])).toEqual([
      ['PUT', 'epoch-A'],
      ['POST', 'epoch-A'],
      ['DELETE', 'epoch-A'],
      ['GET', null],
    ]);
  });

  it('is read ONCE: a later /api/info answer with a newer epoch never reaches this page', async () => {
    loadRepairEpoch();
    await repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    infoEpoch = 'epoch-B'; // the restart repaired something; a poll would see it
    loadRepairEpoch();
    await repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    expect(calls.map((c) => c.epoch)).toEqual(['epoch-A', 'epoch-A']);
  });

  it('a write made before the read settles waits for it and still carries it', async () => {
    let answer!: () => void;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/info') {
        await new Promise<void>((r) => (answer = r));
        return new Response(JSON.stringify({ repairEpoch: 'epoch-late' }));
      }
      calls.push({ url, method: init?.method ?? 'GET', epoch: new Headers(init?.headers).get('x-repair-epoch') });
      return new Response('{}');
    });
    loadRepairEpoch();
    const write = repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    await flush();
    expect(calls).toEqual([]);
    answer();
    await write;
    expect(calls[0].epoch).toBe('epoch-late');
  });

  it('no repair gated (repairEpoch null), or a failed read: writes carry nothing, and pass untouched', async () => {
    infoEpoch = null;
    loadRepairEpoch();
    const init = { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } };
    await repairFetch('/api/books/b/state', init);
    expect(calls[0].epoch).toBeNull();
    __resetRepairEpochForTest();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, i?: RequestInit) => {
      if (String(input) === '/api/info') throw new Error('server down');
      calls.push({ url: String(input), method: i?.method ?? 'GET', epoch: new Headers(i?.headers).get('x-repair-epoch') });
      return new Response('{}');
    });
    loadRepairEpoch();
    await repairFetch('/api/books/b/state', init);
    expect(calls[1].epoch).toBeNull();
  });
});

describe('a refused write reloads the page once and sends nothing more (#3713)', () => {
  it('409 book_repaired_reload: one reload, the caller never sees the response, and the next write is never sent', async () => {
    loadRepairEpoch();
    respond = () => REFUSED();
    const first = repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    expect(await settles(first)).toBe(false); // nothing to toast, nothing to retry
    expect(reload).toHaveBeenCalledTimes(1);
    const second = repairFetch('/api/books/b/state', { method: 'PUT', body: '{"slice":"manuscript"}' });
    expect(await settles(second)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('several writes refused at once still reload once', async () => {
    loadRepairEpoch();
    respond = () => REFUSED();
    void repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' });
    void repairFetch('/api/books/b/cast/c0/series-patch', { method: 'POST', body: '{}' });
    void repairFetch('/api/books/b', { method: 'DELETE' });
    await flush();
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('an ordinary 409 (another code, or not JSON) is handed back and reloads nothing', async () => {
    respond = () => new Response(JSON.stringify({ code: 'stale_base' }), { status: 409 });
    expect((await repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' })).status).toBe(409);
    respond = () => new Response('busy', { status: 409 });
    expect((await repairFetch('/api/books/b', { method: 'DELETE' })).status).toBe(409);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a read answered 409 is not a refusal of a write', async () => {
    respond = () => REFUSED();
    expect((await repairFetch('/api/books/b/state')).status).toBe(409);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a refused series fan-out or design start (the same 409) reloads once and is held', async () => {
    respond = () => REFUSED();
    expect(await settles(repairFetch('/api/books/s/cast/c0/series-patch', { method: 'POST', body: '{}' }))).toBe(false);
    expect(await settles(repairFetch('/api/books/s/cast/design', { method: 'POST', body: '{}' }))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the reload-loop cap (#3713)', () => {
  it('two reloads in the window: the third refusal blocks instead, notifies, and holds writes; reads still go', async () => {
    const now = Date.now();
    sessionStorage.setItem('castwright.repairReloads', JSON.stringify([now - 20_000, now - 10_000]));
    const seen = vi.fn();
    subscribeRepairReloadBlocked(seen);
    respond = () => REFUSED();
    expect(await settles(repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' }))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(isRepairReloadBlocked()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    respond = () => new Response('{}');
    expect(await settles(repairFetch('/api/books/b/state', { method: 'PUT', body: '{}' }))).toBe(false);
    expect(calls).toHaveLength(1);
    expect((await repairFetch('/api/books/b/state')).status).toBe(200);
  });

  it('reloads older than the window do not count', () => {
    const old = Date.now() - 10 * 60_000;
    sessionStorage.setItem('castwright.repairReloads', JSON.stringify([old, old + 1]));
    reloadForRepair();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('castwright.repairReloads')!)).toHaveLength(1);
  });

  it('each automatic reload is counted, so a loop stops at the cap', () => {
    for (let i = 0; i < 3; i++) {
      __resetRepairEpochForTest(); // a reload starts a fresh page; the counter is the session's
      reloadForRepair();
    }
    expect(reload).toHaveBeenCalledTimes(2);
    expect(isRepairReloadBlocked()).toBe(true);
  });

  it('no storage to count in: blocks rather than risk an endless loop', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      reloadForRepair();
      expect(reload).not.toHaveBeenCalled();
      expect(isRepairReloadBlocked()).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
