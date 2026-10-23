/* #3724 — Gemini TTS synthesis must be bounded LOCALLY and honour its caller's
   abort signal. POST /api/voices/:voiceId/sample calls provider.synthesize
   directly (no withCallTimeout), and from @google/genai 2.29 the SDK no longer
   inherits Node's 300 s undici timeout. Mirrors analyzer/voice-style.timeout.test.ts:
   the REAL SDK client against a local endpoint that never answers
   (GOOGLE_GEMINI_BASE_URL), with the ceiling shrunk so the test runs fast. */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { selectTtsProvider } from './index.js';

const CEILING_MS = 400;

vi.mock('./synth-call-timeout.js', () => ({ SYNTH_CALL_TIMEOUT_MS: 400 }));
vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  getResolvedGeminiApiKey: () => 'test-key',
}));

let server: http.Server;
let requests = 0;
const sockets = new Set<import('node:net').Socket>();
const prevBase = process.env.GOOGLE_GEMINI_BASE_URL;

beforeAll(async () => {
  // Accepts the request and never responds.
  server = http.createServer((req) => {
    requests += 1;
    req.resume();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests = 0;
});

afterAll(async () => {
  if (prevBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
  else process.env.GOOGLE_GEMINI_BASE_URL = prevBase;
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const INPUT = { text: 'Hello there.', voiceName: 'Zephyr', modelKey: 'gemini-2.5-flash' } as const;

describe('GeminiTtsProvider.synthesize local bound (#3724)', () => {
  it('rejects at the synth ceiling instead of waiting on a never-answering endpoint', async () => {
    const provider = selectTtsProvider('gemini-2.5-flash');
    const t0 = Date.now();
    await expect(provider.synthesize({ ...INPUT })).rejects.toMatchObject({ name: 'AbortError' });
    const elapsed = Date.now() - t0;
    expect(requests).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(CEILING_MS - 50);
    expect(elapsed).toBeLessThan(CEILING_MS + 2_000);
  }, 5_000);

  it("rejects promptly when the caller's abort signal fires", async () => {
    const provider = selectTtsProvider('gemini-2.5-flash');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    await expect(provider.synthesize({ ...INPUT, signal: ac.signal })).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(CEILING_MS - 50);
    expect(requests).toBe(1);
  }, 5_000);
});
