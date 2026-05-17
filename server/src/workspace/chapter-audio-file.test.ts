/* findChapterAudio / chapterAudioExists — MP3-only locator. The plan-39
   contract: legacy `.wav` files on disk are invisible. A future contributor
   re-introducing a wav branch must trip this regression. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChapterAudio, chapterAudioExists } from './chapter-audio-file.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'chapter-audio-file-test-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('findChapterAudio', () => {
  it('returns the mp3 descriptor when <slug>.mp3 exists on disk', async () => {
    await writeFile(join(workdir, 'ch01.mp3'), 'fake-mp3');
    const result = findChapterAudio(workdir, 'ch01');
    expect(result).not.toBeNull();
    expect(result?.ext).toBe('mp3');
    expect(result?.mime).toBe('audio/mpeg');
    expect(result?.urlSuffix).toBe('audio.mp3');
    expect(result?.path).toBe(join(workdir, 'ch01.mp3'));
  });

  it('returns null when only a legacy .wav exists (post-plan-39, .wav is invisible)', async () => {
    await writeFile(join(workdir, 'ch01.wav'), 'fake-wav');
    expect(findChapterAudio(workdir, 'ch01')).toBeNull();
  });

  it('returns null when no audio exists for the slug', () => {
    expect(findChapterAudio(workdir, 'ch01')).toBeNull();
  });
});

describe('chapterAudioExists', () => {
  it('returns true when <slug>.mp3 exists on disk', async () => {
    await writeFile(join(workdir, 'ch01.mp3'), '');
    expect(chapterAudioExists(workdir, 'ch01')).toBe(true);
  });

  it('returns false when only a legacy .wav exists', async () => {
    await writeFile(join(workdir, 'ch01.wav'), '');
    expect(chapterAudioExists(workdir, 'ch01')).toBe(false);
  });

  it('returns false when nothing exists for the slug', () => {
    expect(chapterAudioExists(workdir, 'ch01')).toBe(false);
  });
});
