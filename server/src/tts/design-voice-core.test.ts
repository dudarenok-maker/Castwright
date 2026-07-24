/* fs-38 Wave 1, Task 9 — the scope-agnostic voice-design core.

   `runVoiceDesign` is the character-less lift of `qwen-voice.ts`'s
   `postDesignAndCache` closure: it POSTs the sidecar `/qwen/design-voice`,
   warms the audition sample cache, and returns the public URL — keyed purely
   off a `storageKey`/`displayName`/`persona`, with no book/cast coupling.

   Mocks mirror routes/qwen-voice.test.ts: `global.fetch` is the sidecar,
   `withCapacityRetry` is a single-call passthrough (its retry policy is
   covered by gpu/capacity-retry.test.ts), and the VRAM sampler is a spy.
   Real ffmpeg encodes the audition (same boundary as voice-sample-cache). */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

let workspaceRoot: string;
let audioDir: string;
let runVoiceDesign: typeof import('./design-voice-core.js').runVoiceDesign;

const fetchMock = vi.fn();
const mockWithCapacityRetry = vi.mocked(withCapacityRetry);

vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

const { maybeSampleSidecarEngineMock } = vi.hoisted(() => ({
  maybeSampleSidecarEngineMock: vi.fn(async (_key: string) => {}),
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({
  maybeSampleSidecarEngine: (key: string) => maybeSampleSidecarEngineMock(key),
}));

/* ~0.3s of silence so ffmpeg produces a real MP3 frame. */
function okSidecarResponse(pcm = new Uint8Array(24_000 * 2 * 0.3)) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
    arrayBuffer: async () => pcm.buffer,
    json: async () => ({}),
  };
}

function isMp3Magic(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3v2
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-design-core-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-design-core-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  vi.stubGlobal('fetch', fetchMock);
  ({ runVoiceDesign } = await import('./design-voice-core.js'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  maybeSampleSidecarEngineMock.mockClear();
  mockWithCapacityRetry.mockReset();
  mockWithCapacityRetry.mockImplementation((doPost, opts) => doPost(opts.signal));
  for (const f of readdirSync(audioDir)) rmSync(join(audioDir, f), { force: true });
});

describe('runVoiceDesign', () => {
  it('designs under the storageKey, warms the sample cache, returns the audition previewUrl', async () => {
    const out = await runVoiceDesign({
      storageKey: 'qwen-abc123',
      displayName: 'Nova',
      persona: 'a calm, measured narrator',
    });

    expect(out.storageKey).toBe('qwen-abc123');
    expect(out.previewUrl).toMatch(/^\/audio\/voices\/qwen-abc123-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);

    /* Sidecar POSTed once with the design body: voiceId == storageKey,
       persona forwarded as instruct, a non-empty calibrationText. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/qwen/design-voice');
    const sent = JSON.parse(init.body);
    expect(sent.voiceId).toBe('qwen-abc123');
    expect(sent.instruct).toBe('a calm, measured narrator');
    expect(sent.language).toBe('English');
    expect(typeof sent.calibrationText).toBe('string');
    expect(sent.calibrationText.length).toBeGreaterThan(0);

    /* A real MP3 landed at the returned URL's filename. */
    const fileName = out.previewUrl!.split('/').pop() as string;
    expect(isMp3Magic(readFileSync(join(audioDir, fileName)))).toBe(true);
  });

  it('preview:true stages under a `<storageKey>-preview` voice id (distinct cache file)', async () => {
    const live = await runVoiceDesign({
      storageKey: 'qwen-xyz',
      displayName: 'Nova',
      persona: 'a warm voice',
    });
    const preview = await runVoiceDesign({
      storageKey: 'qwen-xyz',
      displayName: 'Nova',
      persona: 'a warmer voice',
      preview: true,
    });

    /* The preview POST addresses `<storageKey>-preview`. */
    const previewBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(previewBody.voiceId).toBe('qwen-xyz-preview');

    /* Both share the storageKey cache-scope prefix but are distinct files
       (the voiceName folds into the hash), so the live audition survives. */
    expect(preview.previewUrl).not.toBe(live.previewUrl);
    expect(preview.previewUrl).toMatch(/^\/audio\/voices\/qwen-xyz-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
    expect(existsSync(join(audioDir, live.previewUrl!.split('/').pop() as string))).toBe(true);
  });

  it('rejects with a SidecarDesignError when the sidecar returns a non-OK status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      json: async () => ({ detail: 'design blew up' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(
      runVoiceDesign({ storageKey: 'qwen-boom', displayName: 'X', persona: 'p' }),
    ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 500 });
  });
});
