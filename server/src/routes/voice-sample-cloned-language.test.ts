/* #1951 review fix (M4, seam 1) — THE 500 RISK, pinned end to end.
 *
 * `routes/voice-sample.ts` now passes `cloned` to the provider, which makes
 * `sidecarLanguageName` REACHABLE from a route that forwards a client-supplied,
 * unvalidated `language`. That function throws by design for a language the
 * registry doesn't know. Before this PR the route was protected structurally
 * (no `cloned` flag → no mapping attempt); it is now protected only by
 * `resolveWireLanguage`'s try/catch, so the property has to be tested, not
 * assumed — a working audition must never become a 5xx because the client sent
 * an odd language tag. (Verified by mutation: delete that catch and the second
 * test below goes red with a 502 `tts_failed`.)
 *
 * Unlike voice-sample.test.ts (which stubs the provider entirely), this file
 * wires the ROUTE to a REAL `SidecarTtsProvider` with only the HTTP boundary
 * stubbed. That is the point: a stubbed `synthesize` can never throw from
 * `resolveWireLanguage`, so a 200 from such a test would prove nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { fetch as undiciFetch } from 'undici';

/* The provider posts via undici's OWN fetch (plan 137), not the global one. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
const mockFetch = vi.mocked(undiciFetch);

/* Swap ONLY the provider selection: the route reaches the real
   SidecarTtsProvider (and therefore the real resolveWireLanguage). */
const { provider } = vi.hoisted(() => ({ provider: { current: null as unknown } }));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => provider.current) };
});

let audioDir: string;
let workspaceDir: string;
let app: Express;
let writeEntry: typeof import('../workspace/voice-library.js').writeEntry;

/** Bodies the route's provider actually POSTed to the sidecar. */
let bodies: Record<string, unknown>[];

beforeAll(async () => {
  audioDir = mkdtempSync(join(tmpdir(), 'voice-sample-lang-audio-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'voice-sample-lang-ws-'));
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  process.env.WORKSPACE_DIR = workspaceDir;

  const { SidecarTtsProvider } = await import('../tts/sidecar.js');
  provider.current = new SidecarTtsProvider({ url: 'http://localhost:9000/', engine: 'qwen' });

  const { voiceSampleRouter } = await import('./voice-sample.js');
  ({ writeEntry } = await import('../workspace/voice-library.js'));

  app = express();
  app.use(express.json());
  app.use('/api/voices', voiceSampleRouter);

  await writeEntry({
    voiceUuid: 'clone-500-risk',
    name: 'Gran',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    consent: {
      personName: 'Gran',
      relationship: 'family-with-permission',
      permittedUse: 'personal',
      attestedAt: '2026-01-01T00:00:00.000Z',
      attestedBy: 'me',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

afterAll(() => {
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  bodies = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation((async (_url: unknown, init: unknown) => {
    bodies.push(JSON.parse((init as { body: string }).body));
    // 0.5 s of 24 kHz mono int16 silence — real ffmpeg encodes it fast.
    return new Response(Buffer.alloc(24_000, 0), {
      status: 200,
      headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000', 'x-sample-rate': '24000' },
    });
  }) as unknown as typeof undiciFetch);
});

function play(language: string, text: string) {
  return request(app)
    .post('/api/voices/v_gran/sample')
    .send({
      modelKey: 'qwen3-tts-0.6b',
      voice: {
        id: 'v_gran',
        character: 'Gran',
        overrideTtsVoices: {
          qwen: { name: 'qwen-clone-500-risk', libraryUuid: 'clone-500-risk', provenance: 'cloned' },
        },
      },
      text,
      language,
    });
}

describe('voice-sample × a cloned voice × a client-supplied language', () => {
  /* The fix is live, not inert: the route's `cloned` flag is what lets the
     book language override the clone's English manifest. */
  it('puts the sidecar language WORD on the wire for a supported language', async () => {
    const res = await play('de', 'Guten Abend, mein Lieber.');

    expect(res.status).toBe(200);
    expect(bodies[0].language).toBe('German');
  });

  /* THE REGRESSION. `kl-GL` is not in the language registry, so
     `sidecarLanguageName` throws. The route must still answer 200 with a
     playable sample, and the request must simply omit `language` so the
     sidecar falls back to the voice's manifest — never an English default,
     never a 5xx. */
  it('still returns a working sample for an unregistered language', async () => {
    const res = await play('kl-GL', 'Hello there.');

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.mp3$/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('language');
  });
});
