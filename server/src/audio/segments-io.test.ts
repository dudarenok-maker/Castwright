/* Unit tests for the segments-file readers — focused on the fe-16
   `collectRenderedFallbackEngines` aggregator (Qwen → Kokoro render-time
   fallback, surfaced as the cast Status "Fallback (Kokoro)" pill). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectRenderedFallbackEngines,
  collectRenderedQwenVoiceNames,
  collectRenderedSpeakerMaps,
} from './segments-io.js';

let bookDir: string;

const chapters = [
  { id: 1, slug: '01-one' },
  { id: 2, slug: '02-two' },
];

function writeSegments(slug: string, characterSnapshots: Record<string, object>) {
  writeFileSync(
    join(bookDir, 'audio', `${slug}.segments.json`),
    JSON.stringify({ chapterId: Number(slug.slice(0, 2)), characterSnapshots }),
  );
}

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'segments-io-test-'));
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
});

afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describe('collectRenderedFallbackEngines (fe-16)', () => {
  it('maps a character to kokoro when any rendered chapter stamped the fallback', async () => {
    writeSegments('01-one', {
      sophie: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
      keefe: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-keefe' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({
      sophie: 'kokoro',
    });
  });

  it('wins "any chapter fell back" over a clean render in another chapter', async () => {
    writeSegments('01-one', {
      sophie: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-sophie' },
    });
    writeSegments('02-two', {
      sophie: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({
      sophie: 'kokoro',
    });
  });

  it('returns an empty map when nothing fell back', async () => {
    writeSegments('01-one', {
      keefe: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-keefe' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({});
  });

  it('returns an empty map when no audio dir / segments exist', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({});
  });

  it('does not interfere with the Qwen voice-name aggregator', async () => {
    writeSegments('01-one', {
      keefe: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-keefe' },
      sophie: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
    });
    await expect(collectRenderedQwenVoiceNames(bookDir, chapters)).resolves.toEqual(
      new Set(['qwen-keefe']),
    );
  });
});

describe('collectRenderedSpeakerMaps (#650)', () => {
  function writeSegmentsWithBody(
    slug: string,
    segments: Array<{ characterId?: string; sentenceIds?: number[]; kind?: string }>,
  ) {
    writeFileSync(
      join(bookDir, 'audio', `${slug}.segments.json`),
      JSON.stringify({ chapterId: Number(slug.slice(0, 2)), segments }),
    );
  }

  it('inverts per-character segments into a sentenceId→characterId map per chapter', async () => {
    writeSegmentsWithBody('01-one', [
      { characterId: 'narrator', sentenceIds: [1, 3] },
      { characterId: 'keefe', sentenceIds: [2] },
    ]);
    writeSegmentsWithBody('02-two', [{ characterId: 'sophie', sentenceIds: [4, 5] }]);
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({
      1: { 1: 'narrator', 2: 'keefe', 3: 'narrator' },
      2: { 4: 'sophie', 5: 'sophie' },
    });
  });

  it('skips title/empty segments and omits a chapter with no per-sentence data', async () => {
    writeSegmentsWithBody('01-one', [
      { characterId: 'narrator', sentenceIds: [], kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1] },
    ]);
    /* Legacy file with no `segments` array at all → omitted entirely (so the
       client doesn't read it as "every sentence reassigned"). */
    writeSegments('02-two', { sophie: { voiceEngine: 'kokoro' } });
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({
      1: { 1: 'narrator' },
    });
  });

  it('returns an empty map when no audio dir exists', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({});
  });
});
