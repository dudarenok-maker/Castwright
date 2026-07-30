import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.hoisted — house style (voice-library.test.ts:23) + the repo's documented
// "vi.mock top-level let = TDZ" gotcha. Never a bare top-level `const … = vi.fn()`.
const { transcribeSegment } = vi.hoisted(() => ({ transcribeSegment: vi.fn() }));
vi.mock('./transcribe-client.js', () => ({ transcribeSegment }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  process.env.WORKSPACE_DIR = dir;
  transcribeSegment.mockResolvedValue({ text: 'the quick brown fox', language: 'en', words: null, avgLogprob: null, noSpeechProb: null, compressionRatio: null });
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function wav(seconds: number, amp = 8000, sr = 24_000): Promise<Buffer> {
  const { encodePcmToWav } = await import('./wav.js');
  const n = seconds * sr;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? -amp : amp, i * 2);
  return encodePcmToWav(pcm, sr);
}

describe('ingestCloneSample', () => {
  it('decodes, gates, writes the candidate, and returns the transcript', async () => {
    const { ingestCloneSample } = await import('./clone-ingest.js');
    const { readCandidate } = await import('../workspace/clone-candidate.js');
    const res = await ingestCloneSample(await wav(6), { captureMethod: 'upload', candidateId: 'c1' });
    expect(res.transcript).toBe('the quick brown fox');
    expect(res.durationSeconds).toBeCloseTo(6, 0);
    expect(res.qualityWarnings.join(' ')).toMatch(/short/i); // toContain is strict-equality; use join+toMatch
    expect((await readCandidate('c1'))?.master.captureMethod).toBe('upload');
  });

  it('throws a 400 on a fatally short sample', async () => {
    const { ingestCloneSample, CloneIngestError } = await import('./clone-ingest.js');
    await expect(ingestCloneSample(await wav(2), { captureMethod: 'record', candidateId: 'c2' }))
      .rejects.toMatchObject({ status: 400 });
    void CloneIngestError;
  });

  it('throws a 400 when the audio cannot be decoded', async () => {
    const { ingestCloneSample } = await import('./clone-ingest.js');
    await expect(ingestCloneSample(Buffer.from('not audio'), { captureMethod: 'upload', candidateId: 'c3' }))
      .rejects.toMatchObject({ status: 400 });
  });
  /* #1951 — the detected language was previously discarded here, so
     `deriveEngineArtifact` had nothing to put in `X-Language` and every cloned
     voice's manifest read "English". It must be BOTH returned to the caller and
     PERSISTED on the candidate, because `POST /clone` is a separate request and
     the candidate is the only state that survives between the two. */
  it('retains the Whisper-detected language on the result AND on the persisted candidate', async () => {
    transcribeSegment.mockResolvedValue({ text: 'der alte leuchtturm', language: 'de', words: null, avgLogprob: null, noSpeechProb: null, compressionRatio: null });
    const { ingestCloneSample } = await import('./clone-ingest.js');
    const { readCandidate } = await import('../workspace/clone-candidate.js');
    const res = await ingestCloneSample(await wav(6), { captureMethod: 'upload', candidateId: 'c4' });
    expect(res.detectedLanguage).toBe('de');
    expect((await readCandidate('c4'))?.master.languageCode).toBe('de');
  });

  /* Whisper can legitimately classify nothing. "Unknown" must stay
     distinguishable from a real detection — never silently become English. */
  it('leaves the language unset when Whisper reports none', async () => {
    transcribeSegment.mockResolvedValue({ text: 'hm', language: null, words: null, avgLogprob: null, noSpeechProb: null, compressionRatio: null });
    const { ingestCloneSample } = await import('./clone-ingest.js');
    const { readCandidate } = await import('../workspace/clone-candidate.js');
    const res = await ingestCloneSample(await wav(6), { captureMethod: 'upload', candidateId: 'c5' });
    expect(res.detectedLanguage).toBeNull();
    expect((await readCandidate('c5'))?.master.languageCode).toBeUndefined();
  });
});
