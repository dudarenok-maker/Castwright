/* #3724 — the voice-style Gemini call must be bounded LOCALLY. From
   @google/genai 2.29 the SDK no longer inherits Node's 300 s undici timeout, so a
   call with no `httpOptions.timeout` waits on Google's server-side limit alone.

   Unlike voice-style.test.ts this drives the REAL SDK client against a local
   endpoint that never answers (GOOGLE_GEMINI_BASE_URL) — an injected/mocked
   client bypasses the HTTP dispatcher and could not fail. The ceiling
   (PERSONA_ABSOLUTE_MAX_MS) is shrunk so the test runs in well under a second. */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { generateVoiceStylePersona } from './voice-style.js';
import { _seedGeminiCatalogForTest } from './catalog/gemini-catalog.js';
import { AnalyzerTimeoutError } from './errors.js';

const CEILING_MS = 400;

vi.mock('./ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ollama.js')>()),
  PERSONA_ABSOLUTE_MAX_MS: 400,
}));
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedGeminiApiKey: () => 'test-key',
  readConfigOverrides: () => ({}),
  getCachedUserSettings: vi.fn(() => ({ analyzerEndpointKeys: {}, analyzerEndpoints: [], analyzerRateLimitsByModel: {} })),
}));

const CHARACTER: CastCharacter = { id: 'maerin', name: 'Maerin', role: 'protagonist', gender: 'female' };

let server: http.Server;
let posts = 0;
const sockets = new Set<import('node:net').Socket>();
const prevBase = process.env.GOOGLE_GEMINI_BASE_URL;

beforeAll(async () => {
  // Accepts the request and never responds.
  server = http.createServer((req) => {
    if (req.method === 'POST') posts += 1; // a catalog listing would be a GET
    req.resume();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // Seed the catalog so prepare() makes no listing request ('test-key' is the mocked getResolvedGeminiApiKey).
  _seedGeminiCatalogForTest('test-key', []);
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
  else process.env.GOOGLE_GEMINI_BASE_URL = prevBase;
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('generateVoiceStylePersona gemini branch local timeout (#3724)', () => {
  it('rejects at the persona ceiling instead of waiting on a never-answering endpoint', async () => {
    posts = 0;
    const t0 = Date.now();
    const err = await generateVoiceStylePersona(CHARACTER).catch((e: unknown) => e);
    const elapsed = Date.now() - t0;
    /* #3084 W4 — the ceiling is the transport's and it is terminal: GEMINI_RETRY_CLASSIFIER never retries an
       AnalyzerTimeoutError, so exactly ONE generate POST reaches the fake endpoint. */
    expect(err).toBeInstanceOf(AnalyzerTimeoutError);
    expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(posts).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(CEILING_MS - 50);
    expect(elapsed).toBeLessThan(CEILING_MS + 2_000);
  }, 5_000);
});
