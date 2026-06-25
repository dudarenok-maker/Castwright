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
  collectRenderedTextHashesByChapter,
  textHashForStale,
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
      wren: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
      marlow: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-marlow' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({
      wren: 'kokoro',
    });
  });

  it('wins "any chapter fell back" over a clean render in another chapter', async () => {
    writeSegments('01-one', {
      wren: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-wren' },
    });
    writeSegments('02-two', {
      wren: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({
      wren: 'kokoro',
    });
  });

  it('returns an empty map when nothing fell back', async () => {
    writeSegments('01-one', {
      marlow: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-marlow' },
    });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({});
  });

  it('returns an empty map when no audio dir / segments exist', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({});
  });

  it('does not interfere with the Qwen voice-name aggregator', async () => {
    writeSegments('01-one', {
      marlow: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-marlow' },
      wren: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' },
    });
    await expect(collectRenderedQwenVoiceNames(bookDir, chapters)).resolves.toEqual(
      new Set(['qwen-marlow']),
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
      { characterId: 'marlow', sentenceIds: [2] },
    ]);
    writeSegmentsWithBody('02-two', [{ characterId: 'wren', sentenceIds: [4, 5] }]);
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({
      1: { 1: 'narrator', 2: 'marlow', 3: 'narrator' },
      2: { 4: 'wren', 5: 'wren' },
    });
  });

  it('skips title/empty segments and omits a chapter with no per-sentence data', async () => {
    writeSegmentsWithBody('01-one', [
      { characterId: 'narrator', sentenceIds: [], kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1] },
    ]);
    /* Legacy file with no `segments` array at all → omitted entirely (so the
       client doesn't read it as "every sentence reassigned"). */
    writeSegments('02-two', { wren: { voiceEngine: 'kokoro' } });
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({
      1: { 1: 'narrator' },
    });
  });

  it('returns an empty map when no audio dir exists', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedSpeakerMaps(bookDir, chapters)).resolves.toEqual({});
  });
});

describe('textHashForStale (#1105)', () => {
  it('is deterministic and differs on a text change', () => {
    expect(textHashForStale('Hello there.')).toBe(textHashForStale('Hello there.'));
    expect(textHashForStale('Hello there.')).not.toBe(textHashForStale('Hello there!'));
  });

  it('matches the frontend djb2-base36 vector (cross-package contract)', () => {
    /* MUST equal src/lib/stale-chapters.ts textHashForStale for the same input —
       the frontend staleness diff compares this server-stamped hash against a
       client-computed one. Same vector pinned in both test files. */
    expect(textHashForStale('"Stop," she said.')).toBe('2rq6ja');
  });
});

describe('collectRenderedTextHashesByChapter (#1105)', () => {
  function writeSegmentsWithText(
    slug: string,
    segments: Array<{ characterId?: string; sentenceIds?: number[]; textHash?: string; kind?: string }>,
  ) {
    writeFileSync(
      join(bookDir, 'audio', `${slug}.segments.json`),
      JSON.stringify({ chapterId: Number(slug.slice(0, 2)), segments }),
    );
  }

  it('maps each rendered sentenceId to its segment textHash per chapter', async () => {
    writeSegmentsWithText('01-one', [
      { characterId: 'narrator', sentenceIds: [1], textHash: textHashForStale('The fire caught.') },
      { characterId: 'marlow', sentenceIds: [2], textHash: textHashForStale('"Run," she said.') },
    ]);
    writeSegmentsWithText('02-two', [
      { characterId: 'wren', sentenceIds: [4], textHash: textHashForStale('No one moved.') },
    ]);
    await expect(collectRenderedTextHashesByChapter(bookDir, chapters)).resolves.toEqual({
      1: { 1: textHashForStale('The fire caught.'), 2: textHashForStale('"Run," she said.') },
      2: { 4: textHashForStale('No one moved.') },
    });
  });

  it('skips segments missing a textHash and omits a chapter with no hashes (pre-#1105 render)', async () => {
    writeSegmentsWithText('01-one', [
      { characterId: 'narrator', sentenceIds: [1], kind: 'title' }, // no textHash
      { characterId: 'narrator', sentenceIds: [2], textHash: textHashForStale('Body line.') },
    ]);
    /* A whole chapter rendered before #1105 carries no textHash on any segment →
       omitted entirely, so the client treats it as "can't tell" rather than "all
       sentences edited". */
    writeSegmentsWithText('02-two', [{ characterId: 'wren', sentenceIds: [4] }]);
    await expect(collectRenderedTextHashesByChapter(bookDir, chapters)).resolves.toEqual({
      1: { 2: textHashForStale('Body line.') },
    });
  });

  it('returns an empty map when no audio dir exists', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedTextHashesByChapter(bookDir, chapters)).resolves.toEqual({});
  });
});
