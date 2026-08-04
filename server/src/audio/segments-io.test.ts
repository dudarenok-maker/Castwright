/* Unit tests for the segments-file readers — focused on the fe-16
   `collectRenderedFallbackEngines` aggregator (Qwen → Kokoro render-time
   fallback, surfaced as the cast Status "Fallback (Kokoro)" pill). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectOrphanedCharacterFallbacks,
  collectRenderedFallbackEngines,
  collectRenderedInstructHashesByChapter,
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

/** #2023 — write a segments.json with a raw `segments[]` array (rather than
    `characterSnapshots`), for the orphaned-characterId aggregator, which
    reads per-SEGMENT fields, not the per-character snapshot map. */
function writeSegmentsArray(slug: string, segments: Array<Record<string, unknown>>) {
  writeFileSync(
    join(bookDir, 'audio', `${slug}.segments.json`),
    JSON.stringify({ chapterId: Number(slug.slice(0, 2)), segments }),
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

describe('collectOrphanedCharacterFallbacks (#2023 Piece 1, widened #2040 Wave 3 task 16)', () => {
  const liveCast = [{ id: 'narrator' }, { id: 'mairin' }];

  it('maps an orphaned characterId to who actually rendered it + the voice used, tagged unresolved', async () => {
    writeSegmentsArray('01-one', [
      {
        characterId: 'mayrin',
        sentenceIds: [1],
        renderedFallbackCharacterId: 'narrator',
        voiceName: 'qwen-oduvan',
        baseVoiceName: 'qwen-oduvan',
      },
      { characterId: 'narrator', sentenceIds: [2], voiceName: 'qwen-oduvan' },
    ]);
    // 'mayrin' has no cast entry, no history entry, and doesn't normalise-match
    // 'mairin' (letters differ, not just separators) — genuinely unresolved.
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      mayrin: {
        characterId: 'narrator',
        voiceName: 'qwen-oduvan',
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('omits voiceName when the render recorded none', async () => {
    writeSegmentsArray('01-one', [
      { characterId: 'coalfall', sentenceIds: [1], renderedFallbackCharacterId: 'narrator' },
    ]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      coalfall: {
        characterId: 'narrator',
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('returns an empty map when nothing was substituted', async () => {
    writeSegmentsArray('01-one', [
      { characterId: 'narrator', sentenceIds: [1], voiceName: 'qwen-oduvan' },
    ]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({});
  });

  it('returns an empty map when no audio dir / segments exist', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({});
  });

  it('does not collide with collectRenderedFallbackEngines\'s cast-id keyspace', async () => {
    // Same chapter renders BOTH a real cast character's Qwen→Kokoro engine
    // fallback (keyed by its own cast id, in characterSnapshots) and an
    // orphaned-id substitution (keyed by the orphaned id, in segments[]) —
    // the two aggregators must read their own disjoint parts and never clash.
    writeFileSync(
      join(bookDir, 'audio', '01-one.segments.json'),
      JSON.stringify({
        chapterId: 1,
        characterSnapshots: { wren: { voiceEngine: 'kokoro', renderedFallbackEngine: 'kokoro' } },
        segments: [
          { characterId: 'ghost-character', sentenceIds: [1], renderedFallbackCharacterId: 'narrator' },
        ],
      }),
    );
    await expect(collectRenderedFallbackEngines(bookDir, chapters)).resolves.toEqual({
      wren: 'kokoro',
    });
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      'ghost-character': {
        characterId: 'narrator',
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('reports a segment with no renderedFallbackCharacterId stamp at all (pre-#2023 render, the 188-segment case)', async () => {
    // Measured across all 20 books: 188 orphaned segments, 0 carrying the
    // #2023 stamp. The old gate (`!s.renderedFallbackCharacterId`) skipped
    // every one of them. This is the case the widening exists to fix.
    writeSegmentsArray('01-one', [{ characterId: 'timkin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      timkin: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('tags a segment resolved through the id-history side-table as alias', async () => {
    // 'mayrin' was retired in favour of the live 'mairin' row.
    writeSegmentsArray('01-one', [{ characterId: 'mayrin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, { mayrin: 'mairin' }),
    ).resolves.toEqual({
      mayrin: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'alias',
        resolvedCharacterId: 'mairin',
        segments: 1,
      },
    });
  });

  it('tags a segment resolved only through separator/case normalisation as normalised', async () => {
    // 'the_mairin' normalises to the same key as the live 'the-mairin' row —
    // no history entry involved.
    writeSegmentsArray('01-one', [{ characterId: 'the_mairin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(
        bookDir,
        chapters,
        [{ id: 'the-mairin' }],
        {},
      ),
    ).resolves.toEqual({
      the_mairin: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'normalised',
        resolvedCharacterId: 'the-mairin',
        segments: 1,
      },
    });
  });

  it('tier 3 (live normalised id) beats tier 4 (unrelated normalised history entry) — CRITICAL repro', async () => {
    // #2040 Wave 3 review round 1 CRITICAL. 'the-mairin' is a live cast id
    // (tier 3, normalised). A DIFFERENT, unrelated history entry
    // ('the_Mairin' -> 'wren') also normalises to the same key (tier 4). The
    // resolver's own precedence must pick tier 3 — the collector must tag
    // this 'normalised' resolving onto 'the-mairin', NOT 'alias' resolving
    // onto 'wren' via the coincidentally-matching history entry.
    const cast = [{ id: 'wren' }, { id: 'the-mairin' }];
    const history = { the_Mairin: 'wren' };
    writeSegmentsArray('01-one', [{ characterId: 'the-Mairin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, cast, history),
    ).resolves.toEqual({
      'the-Mairin': {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'normalised',
        resolvedCharacterId: 'the-mairin',
        segments: 1,
      },
    });
  });

  it('never reports a segment whose characterId is an exact live cast id', async () => {
    writeSegmentsArray('01-one', [{ characterId: 'mairin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({});
  });

  it('an alias whose history target is no longer live does not resolve, and is unresolved', async () => {
    // The history entry points at 'deleted-char', which isn't in liveCast —
    // buildCastResolver drops history entries with a dead target, so this
    // must fall through to unresolved rather than being reported as an alias.
    writeSegmentsArray('01-one', [{ characterId: 'ghost', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {
        ghost: 'deleted-char',
      }),
    ).resolves.toEqual({
      ghost: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('reports a rejected id as unresolved even though its history entry would otherwise resolve it (#2040 Task 17)', async () => {
    // 'mayrin' is retired to the live 'mairin' row (would tag 'alias' per the
    // dedicated test above) — but the user has rejected this exact
    // reconciliation, so the collector must report it unresolved on the very
    // next hydrate rather than continuing to show the match the user said was
    // wrong.
    writeSegmentsArray('01-one', [{ characterId: 'mayrin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(
        bookDir,
        chapters,
        liveCast,
        { mayrin: 'mairin' },
        ['mayrin'],
      ),
    ).resolves.toEqual({
      mayrin: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 1,
      },
    });
  });

  it('does not reject an id absent from rejectedIds, even when other ids are rejected', async () => {
    writeSegmentsArray('01-one', [{ characterId: 'mayrin', sentenceIds: [1] }]);
    await expect(
      collectOrphanedCharacterFallbacks(
        bookDir,
        chapters,
        liveCast,
        { mayrin: 'mairin' },
        ['some-other-id'],
      ),
    ).resolves.toEqual({
      mayrin: {
        characterId: undefined,
        voiceName: undefined,
        resolution: 'alias',
        resolvedCharacterId: 'mairin',
        segments: 1,
      },
    });
  });

  it('accumulates the segment count across multiple rendered chapters for the same orphaned id', async () => {
    writeSegmentsArray('01-one', [
      { characterId: 'timkin', sentenceIds: [1], renderedFallbackCharacterId: 'narrator' },
    ]);
    writeSegmentsArray('02-two', [{ characterId: 'timkin', sentenceIds: [4] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      timkin: {
        characterId: 'narrator',
        voiceName: undefined,
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 2,
      },
    });
  });

  it('forward-fills voiceName from an earlier chapter when a later occurrence carries none', async () => {
    // #2040 Wave 3 review round 1 IMPORTANT — the same forward-fill pattern
    // as characterId above (line ~370's `?? existing?.characterId`), but for
    // `voiceName` (`?? existing?.voiceName`). The characterId case was
    // already covered by the accumulation test above; this pins voiceName's
    // sibling branch, which every other multi-occurrence fixture in this
    // file leaves unexercised (baseVoiceName unset on both segments).
    writeSegmentsArray('01-one', [
      { characterId: 'timkin', sentenceIds: [1], baseVoiceName: 'qwen-oduvan' },
    ]);
    writeSegmentsArray('02-two', [{ characterId: 'timkin', sentenceIds: [4] }]);
    await expect(
      collectOrphanedCharacterFallbacks(bookDir, chapters, liveCast, {}),
    ).resolves.toEqual({
      timkin: {
        characterId: undefined,
        voiceName: 'qwen-oduvan',
        resolution: 'unresolved',
        resolvedCharacterId: undefined,
        segments: 2,
      },
    });
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

describe('collectRenderedInstructHashesByChapter (fs-58)', () => {
  /* Mirrors the textHash collector's describe-private fixture writer, adding the
     fs-58 `instructHash` field (stamped only on the per-group 1.7b liveInstruct
     path). The chapterId is derived from the slug's numeric prefix. */
  function writeSegmentsWithInstruct(
    slug: string,
    segments: Array<{
      characterId?: string;
      sentenceIds?: number[];
      instructHash?: string;
      kind?: string;
    }>,
  ) {
    writeFileSync(
      join(bookDir, 'audio', `${slug}.segments.json`),
      JSON.stringify({ chapterId: Number(slug.slice(0, 2)), segments }),
    );
  }

  it('inverts per-segment instructHash to {chapterId:{sentenceId:hash}}, omitting empty chapters', async () => {
    /* ch1 has a stamped instructHash on sentence 5; ch2 has none (non-liveInstruct
       render) → omitted entirely so the client reads it as "can't tell". */
    writeSegmentsWithInstruct('01-one', [
      { characterId: 'mira', sentenceIds: [5], instructHash: textHashForStale('a tired sigh') },
    ]);
    writeSegmentsWithInstruct('02-two', [{ characterId: 'wren', sentenceIds: [4] }]);
    await expect(collectRenderedInstructHashesByChapter(bookDir, chapters)).resolves.toEqual({
      1: { 5: textHashForStale('a tired sigh') },
    });
  });

  it('skips segments missing an instructHash and omits a wholly-unstamped chapter', async () => {
    writeSegmentsWithInstruct('01-one', [
      { characterId: 'narrator', sentenceIds: [1], kind: 'title' }, // no instructHash
      { characterId: 'mira', sentenceIds: [2], instructHash: textHashForStale('a calm tone') },
    ]);
    writeSegmentsWithInstruct('02-two', [{ characterId: 'wren', sentenceIds: [4] }]);
    await expect(collectRenderedInstructHashesByChapter(bookDir, chapters)).resolves.toEqual({
      1: { 2: textHashForStale('a calm tone') },
    });
  });

  it('returns an empty map when no audio dir exists', async () => {
    rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
    await expect(collectRenderedInstructHashesByChapter(bookDir, chapters)).resolves.toEqual({});
  });
});
