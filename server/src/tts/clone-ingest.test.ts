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
});
