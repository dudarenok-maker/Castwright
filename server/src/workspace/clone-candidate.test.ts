import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cand-'));
  process.env.WORKSPACE_DIR = dir;
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

it('writes, reads back, and removes a candidate', async () => {
  const { writeCandidate, readCandidate, candidateMasterPath, removeCandidate } = await import('./clone-candidate.js');
  const master = { sampleRate: 24_000, durationSeconds: 6, transcript: 'hi', transcriptSource: 'whisper' as const, captureMethod: 'upload' as const };
  await writeCandidate('cand1', master, Buffer.from('RIFFfake'));
  expect(existsSync(candidateMasterPath('cand1'))).toBe(true);
  const read = await readCandidate('cand1');
  expect(read?.master.transcript).toBe('hi');
  expect(read?.master.clipFile).toBe('master.wav');
  await removeCandidate('cand1');
  expect(existsSync(candidateMasterPath('cand1'))).toBe(false);
});

it('readCandidate returns null for an unknown id', async () => {
  const { readCandidate } = await import('./clone-candidate.js');
  expect(await readCandidate('nope')).toBeNull();
});
