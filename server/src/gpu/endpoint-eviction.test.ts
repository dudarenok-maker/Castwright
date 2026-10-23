import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  endpointsSharingDevice,
  evictEndpointsOnDevice,
  endpointUnloadNotes,
  ENDPOINT_UNLOAD_TIMEOUT_MS,
  type EndpointUnloadOutcome,
} from './endpoint-eviction.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import { markEndpointRunActive, _resetEndpointBusyForTest } from '../analyzer/analyzer-concurrency.js';
import { noteEndpointModelUsed, servedModels, _resetEndpointRuntimeForTest } from '../analyzer/transports/endpoint-runtime.js';

/* The busy registry and the served set are module state; a leaked mark or model from one case
   would silently change the next case's answer. */
beforeEach(() => {
  _resetEndpointBusyForTest();
  _resetEndpointRuntimeForTest();
});

const ep = (id: string, gpu: string, unloadUrl?: string) =>
  analyzerEndpointSchema.parse({ id, name: id.toUpperCase(), baseUrl: `http://127.0.0.1:8080/v1`, gpu, contextTokens: 8192, ...(unloadUrl ? { unloadUrl } : {}) });

const settings = (endpoints: ReturnType<typeof ep>[], keys: UserSettings['analyzerEndpointKeys'] = {}): UserSettings => ({
  ...DEFAULT_USER_SETTINGS, analyzerEndpoints: endpoints, analyzerEndpointKeys: keys,
});

const idle = () => false;
const PER_MODEL = 'http://127.0.0.1:8080/api/models/unload/{model}';
const none = () => [] as string[];

describe('endpointsSharingDevice (#3084)', () => {
  it("matches 'any' and the exact device key, never 'none' or another card", () => {
    const list = [ep('a', 'any'), ep('b', 'cuda:0'), ep('c', 'cuda:1'), ep('d', 'none')];
    expect(endpointsSharingDevice(list, 'cuda:0').map((e) => e.id)).toEqual(['a', 'b']);
    expect(endpointsSharingDevice(list, 'cuda:1').map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('evictEndpointsOnDevice (#3084)', () => {
  it('POSTs only matching endpoints with an unload URL, substituting {model}', async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response('OK'));
    const s = settings([ep('swap0', 'cuda:0', PER_MODEL), ep('swap1', 'cuda:1', PER_MODEL), ep('nourl', 'cuda:0')]);
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b'], isEndpointBusy: idle });
    expect(out).toEqual({ attempted: 1, unloaded: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8080/api/models/unload/qwen3-30b');
    expect((fetch.mock.calls[0][1] as { method: string }).method).toBe('POST');
  });

  it('POSTs once per model whose request has been sent to the endpoint (P3, N2: a phase-0/phase-1 split on one endpoint)', async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response('OK'));
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b', 'gemma3:12b'], isEndpointBusy: idle });
    expect(out).toEqual({ attempted: 2, unloaded: 2 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:8080/api/models/unload/qwen3-30b',
      'http://127.0.0.1:8080/api/models/unload/gemma3%3A12b',
    ]);
  });

  it('skips a {model} URL when no model has been sent to the endpoint since server start', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const s = settings([ep('swap0', 'any', PER_MODEL)]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: idle })).toEqual({ attempted: 0, unloaded: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an unload URL without {model} is POSTed exactly once, whether or not models have served', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const s = settings([ep('all', 'cuda:0', 'http://127.0.0.1:8080/api/models/unload')]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: idle })).toEqual({ attempted: 1, unloaded: 1 });
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['a', 'b'], isEndpointBusy: idle })).toEqual({ attempted: 1, unloaded: 1 });
  });

  it('sends the key as a Bearer token only when its origin matches, and skips a mismatched key', async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response('OK'));
    const url = 'http://127.0.0.1:8080/api/models/unload';
    await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => settings([ep('a', 'any', url)], { a: { origin: 'http://127.0.0.1:8080', key: 'sk-a' } }), servedModels: () => ['m'], isEndpointBusy: idle });
    expect((fetch.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-a');
    fetch.mockClear();
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => settings([ep('a', 'any', url)], { a: { origin: 'http://10.0.0.5:8080', key: 'sk-a' } }), servedModels: () => ['m'], isEndpointBusy: idle });
    expect(out).toEqual({ attempted: 0, unloaded: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a failing POST is best-effort: counted as attempted, never as unloaded, logged, never thrown (N1)', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings([ep('a', 'any', 'http://127.0.0.1:8080/unload'), ep('b', 'cuda:0', 'http://127.0.0.1:8080/unload')]);
    /* `unloaded: 0` is what keeps Task 3d.3's latch clear, so the next denial tries again. */
    await expect(evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['m'], isEndpointBusy: idle })).resolves.toEqual({ attempted: 2, unloaded: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a non-2xx answer counts as attempted but not unloaded (N1)', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings([ep('a', 'any', 'http://127.0.0.1:8080/unload')]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: idle })).toEqual({ attempted: 1, unloaded: 0 });
    warn.mockRestore();
  });

  it('an unload endpoint that 500s echoing the key never logs it, even where the log truncates (P22)', async () => {
    const KEY = 'sk-lab-unload-secret-0001';
    /* A real server: the key travels in the real Authorization header and comes back in the 500 body.
       280 characters of padding put the echoed key across the log's 300-character cut. */
    const server = createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`${'x'.repeat(280)}${req.headers.authorization ?? ''}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'LAB', baseUrl: `${origin}/v1`, gpu: 'cuda:0', contextTokens: 8192, unloadUrl: `${origin}/unload` });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await evictEndpointsOnDevice('cuda:0', { settings: () => settings([lab], { lab: { origin, key: KEY } }), servedModels: none, isEndpointBusy: idle });
      expect(out).toEqual({ attempted: 1, unloaded: 0 });
      const logged = warn.mock.calls.flat().join('\n');
      expect(logged).toContain('returned 500');
      expect(logged).toContain('[redacted]');
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain(KEY.slice(0, 13));
    } finally {
      warn.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a thrown unload error that carries the key is logged redacted (P22)', async () => {
    const KEY = 'sk-lab-unload-secret-0002';
    const fetch = vi.fn(async () => {
      throw new Error(`connect failed while sending Bearer ${KEY}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = settings([ep('a', 'any', 'http://127.0.0.1:8080/unload')], { a: { origin: 'http://127.0.0.1:8080', key: KEY } });
    await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: idle });
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(KEY);
    warn.mockRestore();
  });

  it('a busy endpoint is skipped; an idle endpoint on the same card is still unloaded (P1)', async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('busy', 'cuda:0', 'http://127.0.0.1:8080/unload-busy'), ep('idle', 'any', 'http://127.0.0.1:8080/unload-idle')]);
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: (id) => id === 'busy' });
    expect(out).toEqual({ attempted: 1, unloaded: 1 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['http://127.0.0.1:8080/unload-idle']);
    info.mockRestore();
  });

  it('logs "busy; not unloading" once per endpoint per admission, however many polls ask (N1)', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('busy', 'cuda:0', 'http://127.0.0.1:8080/unload-busy')]);
    /* One set per withCapacityRetry call (Task 3d.3 creates it); the loop asks on every poll. */
    const loggedBusy = new Set<string>();
    const deps = { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: () => true, loggedBusy };
    for (let i = 0; i < 5; i += 1) expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 0, unloaded: 0 });
    const busyLines = info.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('busy; not unloading'));
    expect(busyLines).toHaveLength(1);
    /* A later admission gets its own set, and so its own line. */
    expect(await evictEndpointsOnDevice('cuda:0', { ...deps, loggedBusy: new Set<string>() })).toEqual({ attempted: 0, unloaded: 0 });
    expect(info.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('busy; not unloading'))).toHaveLength(2);
    info.mockRestore();
  });

  it('re-checks the busy state immediately before each POST: a run that starts during the first POST skips the second', async () => {
    let busy = false;
    const fetch = vi.fn(async () => {
      busy = true;
      return new Response('OK');
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    const out = await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b', 'gemma3:12b'], isEndpointBusy: () => busy });
    expect(out).toEqual({ attempted: 1, unloaded: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('with the real busy registry, a run between two chunk calls (no call in flight) blocks the unload', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    const release = markEndpointRunActive(['swap']);
    try {
      expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b'] })).toEqual({ attempted: 0, unloaded: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      release();
      info.mockRestore();
    }
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b'] })).toEqual({ attempted: 1, unloaded: 1 });
  });

  /* A1 — the attempt bound is per (endpoint, model), not per endpoint and not per admission.
     These cases drive what a real admission sees: several endpoints and several models over
     several polls, sharing ONE set of per-admission state exactly as Task 3d.3 wires it. A
     single-model, single-endpoint stub cannot tell the two keyings apart, which is how the
     original defect passed every earlier case. */
  const admission = () => ({ loggedBusy: new Set<string>(), attemptedEndpoints: new Set<string>(), endpointOutcomes: new Map<string, EndpointUnloadOutcome>() });

  it('endpoint B, busy at the first poll and idle at a later one, is unloaded after A was already unloaded (A1)', async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('a', 'cuda:0', 'http://127.0.0.1:8080/unload-a/{model}'), ep('b', 'any', 'http://127.0.0.1:8080/unload-b/{model}')]);
    const state = admission();
    let bBusy = true;
    const deps = { fetch: fetch as never, settings: () => s, servedModels: (id: string) => (id === 'a' ? ['qwen3-30b'] : ['gemma3:12b']), isEndpointBusy: (id: string) => id === 'b' && bBusy, forgetServedModel: () => {}, ...state };
    /* Poll 1: A unloads, B is busy. */
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 1, unloaded: 1 });
    /* Polls 2..9: B still busy; A's slot is spent, so nothing is sent. */
    for (let i = 0; i < 8; i += 1) expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 0, unloaded: 0 });
    /* Poll 10: B goes idle and is asked — nothing latched it out. */
    bBusy = false;
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 1, unloaded: 1 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:8080/unload-a/qwen3-30b',
      'http://127.0.0.1:8080/unload-b/gemma3%3A12b',
    ]);
    info.mockRestore();
  });

  it('a busy break part-way through one endpoint\'s models leaves models 2..N eligible on a later poll (A1)', async () => {
    let busy = false;
    const fetch = vi.fn(async (_url: string, _init?: unknown) => {
      busy = true; // a chunk call starts while model 1's POST is out
      return new Response('OK');
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    const deps = { fetch: fetch as never, settings: () => s, servedModels: () => ['m1', 'm2', 'm3'], isEndpointBusy: () => busy, forgetServedModel: () => {}, ...admission() };
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 1, unloaded: 1 });
    /* The run ends; the same admission polls again. m2 and m3 were never attempted. */
    busy = false;
    fetch.mockImplementation(async () => new Response('OK'));
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 2, unloaded: 2 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:8080/api/models/unload/m1',
      'http://127.0.0.1:8080/api/models/unload/m2',
      'http://127.0.0.1:8080/api/models/unload/m3',
    ]);
    info.mockRestore();
  });

  it('a hung POST is never retried for that (endpoint, model) in the same admission, but the endpoint\'s other model still is (A1)', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/hangs')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response('OK');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    const state = admission();
    const deps = { fetch: fetch as never, settings: () => s, servedModels: () => ['hangs', 'ok'], isEndpointBusy: idle, forgetServedModel: () => {}, ...state };
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 2, unloaded: 1 });
    /* The next 29 polls of the same admission send nothing: both slots are spent. */
    for (let i = 0; i < 29; i += 1) expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 0, unloaded: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    /* A fresh admission tries the hung model again. */
    expect(await evictEndpointsOnDevice('cuda:0', { ...deps, ...admission() })).toEqual({ attempted: 2, unloaded: 1 });
    expect(fetch).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    info.mockRestore();
  });

  it('a busy endpoint is not an attempt: it is still reconsidered later and then unloaded', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('busy', 'cuda:0', 'http://127.0.0.1:8080/unload-busy')]);
    let busy = true;
    const deps = { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: () => busy, forgetServedModel: () => {}, ...admission() };
    /* Still busy on this poll: no attempt, so no slot is spent. */
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 0, unloaded: 0 });
    expect(fetch).not.toHaveBeenCalled();
    /* Goes idle on a later poll of the SAME admission (same set): now it is attempted and unloaded. */
    busy = false;
    expect(await evictEndpointsOnDevice('cuda:0', deps)).toEqual({ attempted: 1, unloaded: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  /* The served set, with the real endpoint-runtime module (w3ab's forgetEndpointModel). */
  it('a 2xx unload removes that model from the served set; the next admission does not POST it again', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    noteEndpointModelUsed('swap', 'qwen3-30b');
    noteEndpointModelUsed('swap', 'gemma3:12b');
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, isEndpointBusy: idle, ...admission() })).toEqual({ attempted: 2, unloaded: 2 });
    expect(servedModels('swap')).toEqual([]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, isEndpointBusy: idle, ...admission() })).toEqual({ attempted: 0, unloaded: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    info.mockRestore();
  });

  it('a 404 removes the model too (the server is not holding it) but does not count as unloaded; a 503 keeps it', async () => {
    const fetch = vi.fn(async (url: string) => new Response('', { status: url.endsWith('/gone') ? 404 : 503 }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteEndpointModelUsed('swap', 'gone');
    noteEndpointModelUsed('swap', 'stuck');
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, isEndpointBusy: idle, ...admission() })).toEqual({ attempted: 2, unloaded: 0 });
    expect(servedModels('swap')).toEqual(['stuck']);
    /* A 404 is not a failure: it is logged as info, not warned. */
    expect(warn.mock.calls.flat().join('\n')).not.toContain('returned 404');
    info.mockRestore();
    warn.mockRestore();
  });

  it('a 2xx from an all-models URL clears the endpoint\'s whole served set', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    noteEndpointModelUsed('all', 'a');
    noteEndpointModelUsed('all', 'b');
    const s = settings([ep('all', 'cuda:0', 'http://127.0.0.1:8080/api/models/unload')]);
    expect(await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, isEndpointBusy: idle, ...admission() })).toEqual({ attempted: 1, unloaded: 1 });
    expect(servedModels('all')).toEqual([]);
    info.mockRestore();
  });

  it('logs one info line per successful unload, naming the endpoint and model', async () => {
    const fetch = vi.fn(async () => new Response('OK'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([ep('swap', 'cuda:0', PER_MODEL)]);
    await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: () => ['qwen3-30b', 'gemma3:12b'], isEndpointBusy: idle, forgetServedModel: () => {}, ...admission() });
    const lines = info.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('no longer holds'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"SWAP"');
    expect(lines[0]).toContain('qwen3-30b');
    info.mockRestore();
  });

  it('records per-endpoint outcomes for the notes: freed, failed, busy (A6)', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('down') ? Promise.reject(new Error('ECONNREFUSED')) : new Response('OK')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = settings([
      ep('ok', 'cuda:0', 'http://127.0.0.1:8080/unload-ok'),
      ep('down', 'cuda:0', 'http://127.0.0.1:8081/unload-down'),
      ep('busy', 'cuda:0', 'http://127.0.0.1:8082/unload-busy'),
    ]);
    const state = admission();
    await evictEndpointsOnDevice('cuda:0', { fetch: fetch as never, settings: () => s, servedModels: none, isEndpointBusy: (id) => id === 'busy', forgetServedModel: () => {}, ...state });
    expect(Object.fromEntries(state.endpointOutcomes)).toEqual({
      ok: { freed: 1, failed: 0, busy: false },
      down: { freed: 0, failed: 1, busy: false },
      busy: { freed: 0, failed: 0, busy: true },
    });
    warn.mockRestore();
    info.mockRestore();
  });

  it('ENDPOINT_UNLOAD_TIMEOUT_MS is 10 s, not the 30 s a hanging endpoint used to be allowed', () => {
    expect(ENDPOINT_UNLOAD_TIMEOUT_MS).toBe(10_000);
  });
});

describe('endpointUnloadNotes (#3084)', () => {
  it('names each sharing endpoint without an unload URL and the setting to fill in', () => {
    const notes = endpointUnloadNotes(
      'cuda:0',
      settings([ep('lab', 'cuda:0'), ep('other', 'cuda:1'), ep('ok', 'any', 'http://127.0.0.1:8080/unload')]),
      () => ['m'],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"LAB"');
    expect(notes[0]).toContain('Unload URL');
  });

  it('names a {model} endpoint that has nothing to unload because no model has run on it since Castwright started (N2)', () => {
    const notes = endpointUnloadNotes('cuda:0', settings([ep('swap', 'cuda:0', PER_MODEL), ep('other', 'cuda:1', PER_MODEL)]), none);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"SWAP"');
    expect(notes[0]).toContain('since Castwright started');
    /* Once a model has run on it, the endpoint is unloadable and gets no note. */
    expect(endpointUnloadNotes('cuda:0', settings([ep('swap', 'cuda:0', PER_MODEL)]), () => ['qwen3-30b'])).toEqual([]);
  });

  it('names every cause, one note per sharing endpoint, each naming the endpoint (A6)', () => {
    const s = settings([
      ep('nourl', 'cuda:0'),
      ep('busy', 'cuda:0', PER_MODEL),
      ep('down', 'cuda:0', PER_MODEL),
      ep('spent', 'any', PER_MODEL),
      ep('fresh', 'cuda:0', PER_MODEL),
      ep('elsewhere', 'cuda:1', PER_MODEL),
    ]);
    const outcomes = new Map<string, EndpointUnloadOutcome>([
      ['busy', { freed: 0, failed: 0, busy: true }],
      ['down', { freed: 0, failed: 2, busy: false }],
      ['spent', { freed: 2, failed: 0, busy: false }],
    ]);
    const notes = endpointUnloadNotes('cuda:0', s, (id) => (id === 'fresh' ? [] : ['m']), outcomes);
    expect(notes).toHaveLength(5);
    expect(notes[0]).toMatch(/"NOURL".*Unload URL/);
    expect(notes[1]).toMatch(/"BUSY".*busy for the whole wait/);
    expect(notes[2]).toMatch(/"DOWN".*every unload request .* failed/);
    expect(notes[3]).toMatch(/"SPENT".*unloaded 2 model/);
    expect(notes[4]).toMatch(/"FRESH".*since Castwright started/);
  });

  it('an endpoint whose models were all just unloaded is never told "no model has run on it" (A6 precedence)', () => {
    const notes = endpointUnloadNotes('cuda:0', settings([ep('swap', 'cuda:0', PER_MODEL)]), none, new Map([['swap', { freed: 2, failed: 0, busy: false }]]));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('unloaded 2 model');
    expect(notes[0]).not.toContain('since Castwright started');
  });

  it('busy at one poll and then POSTed is not "busy throughout" (A6)', () => {
    const notes = endpointUnloadNotes('cuda:0', settings([ep('swap', 'cuda:0', PER_MODEL)]), () => ['m'], new Map([['swap', { freed: 0, failed: 1, busy: true }]]));
    expect(notes[0]).toContain('every unload request');
    expect(notes[0]).not.toContain('busy for the whole wait');
  });
});
