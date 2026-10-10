/* Pin the two-pass rename, segments.json metadata rewrite, and delete
 * semantics of rewriteChapterSlugs (plan 51). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteChapterSlugs } from './rewrite-chapter-slugs.js';

let workRoot: string;
let audioRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'rewrite-chapter-slugs-'));
  audioRoot = join(workRoot, 'audio');
  mkdirSync(audioRoot, { recursive: true });
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function seed(slug: string, opts?: { segments?: object }): void {
  writeFileSync(join(audioRoot, `${slug}.mp3`), `audio-bytes:${slug}`);
  writeFileSync(
    join(audioRoot, `${slug}.segments.json`),
    JSON.stringify(opts?.segments ?? { bookId: 'b', chapterId: 99, chapterTitle: 'OLD', segments: [] }),
  );
  writeFileSync(join(audioRoot, `${slug}.peaks.json`), JSON.stringify({ peaks: [] }));
}

describe('rewriteChapterSlugs', () => {
  it('returns an empty summary when the audio root does not exist', async () => {
    rmSync(audioRoot, { recursive: true, force: true });
    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'delete', from: '01-anything' },
    ]);
    expect(result).toEqual({ renamed: [], deleted: [], errors: [] });
  });

  it('renames the three companion files for one slug and updates segments.json metadata', async () => {
    seed('02-old-title', {
      segments: { bookId: 'b', chapterId: 2, chapterTitle: 'old', segments: [] },
    });

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '02-old-title', to: '03-new-title', newChapterId: 3, newChapterTitle: 'new' },
    ]);

    // Source files gone, destination files present
    expect(existsSync(join(audioRoot, '02-old-title.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '03-new-title.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '03-new-title.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '03-new-title.peaks.json'))).toBe(true);
    // Content preserved (mp3 bytes survived the round-trip)
    expect(readFileSync(join(audioRoot, '03-new-title.mp3'), 'utf8')).toBe('audio-bytes:02-old-title');
    // segments.json rewrote chapterId + chapterTitle
    const segOut = JSON.parse(readFileSync(join(audioRoot, '03-new-title.segments.json'), 'utf8'));
    expect(segOut).toMatchObject({ chapterId: 3, chapterTitle: 'new', bookId: 'b' });
    // Summary captures three renamed companions and no errors
    expect(result.errors).toEqual([]);
    expect(result.renamed.map((r) => r.suffix).sort()).toEqual(
      ['mp3', 'peaks.json', 'segments.json'],
    );
  });

  it('rotates three chapters without clobbering (two-pass via temp slug)', async () => {
    seed('01-a');
    seed('02-b');
    seed('03-c');

    const result = await rewriteChapterSlugs(audioRoot, [
      // 1 → 2, 2 → 3, 3 → 1 (rotate)
      { kind: 'rename', from: '01-a', to: '02-a', newChapterId: 2, newChapterTitle: 'A' },
      { kind: 'rename', from: '02-b', to: '03-b', newChapterId: 3, newChapterTitle: 'B' },
      { kind: 'rename', from: '03-c', to: '01-c', newChapterId: 1, newChapterTitle: 'C' },
    ]);

    expect(result.errors).toEqual([]);
    // Each target slug should now hold the originally-seeded bytes.
    expect(readFileSync(join(audioRoot, '02-a.mp3'), 'utf8')).toBe('audio-bytes:01-a');
    expect(readFileSync(join(audioRoot, '03-b.mp3'), 'utf8')).toBe('audio-bytes:02-b');
    expect(readFileSync(join(audioRoot, '01-c.mp3'), 'utf8')).toBe('audio-bytes:03-c');
    // No source slugs left behind
    expect(existsSync(join(audioRoot, '01-a.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '02-b.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '03-c.mp3'))).toBe(false);
    // No temp .relabel-* leftovers
    const allFiles = readDirNames(audioRoot);
    expect(allFiles.filter((n) => /\.relabel-/.test(n))).toEqual([]);
  });

  it('deletes all three companion files for a delete op', async () => {
    seed('05-doomed');
    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'delete', from: '05-doomed' },
    ]);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(audioRoot, '05-doomed.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '05-doomed.segments.json'))).toBe(false);
    expect(existsSync(join(audioRoot, '05-doomed.peaks.json'))).toBe(false);
    expect(result.deleted.map((d) => d.suffix).sort()).toEqual(
      ['mp3', 'peaks.json', 'segments.json'],
    );
  });

  it('mixed batch: renames apply, delete of already-renamed-FROM slug is a no-op', async () => {
    seed('02-b');
    seed('03-c'); // will get deleted

    const result = await rewriteChapterSlugs(audioRoot, [
      // rename 2 → 1 first
      { kind: 'rename', from: '02-b', to: '01-b', newChapterId: 1, newChapterTitle: 'B' },
      // delete 3 (was real)
      { kind: 'delete', from: '03-c' },
    ]);

    expect(result.errors).toEqual([]);
    expect(existsSync(join(audioRoot, '01-b.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '02-b.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '03-c.mp3'))).toBe(false);
  });

  it('tolerates missing source files on rename (no error, no rename recorded)', async () => {
    // Seed only mp3, not the segments/peaks
    writeFileSync(join(audioRoot, '02-x.mp3'), 'x');

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '02-x', to: '03-x', newChapterId: 3, newChapterTitle: 'X' },
    ]);

    expect(result.errors).toEqual([]);
    expect(existsSync(join(audioRoot, '03-x.mp3'))).toBe(true);
    // Only one companion (mp3) renamed; segments + peaks had nothing to move
    expect(result.renamed.map((r) => r.suffix)).toEqual(['mp3']);
  });

  // #3400 — finalize writes <slug>.m4a / <slug>.ogg for non-mp3 books; the live
  // audio must follow the same rename/delete rules as .mp3.
  for (const ext of ['m4a', 'ogg'] as const) {
    it(`swaps two chapters' live .${ext} audio together with their segments`, async () => {
      for (const slug of ['01-a', '02-b']) {
        writeFileSync(join(audioRoot, `${slug}.${ext}`), `audio-bytes:${slug}`);
        writeFileSync(join(audioRoot, `${slug}.segments.json`), JSON.stringify({ segments: [] }));
      }
      const result = await rewriteChapterSlugs(audioRoot, [
        { kind: 'rename', from: '01-a', to: '02-a', newChapterId: 2, newChapterTitle: 'A' },
        { kind: 'rename', from: '02-b', to: '01-b', newChapterId: 1, newChapterTitle: 'B' },
      ]);
      expect(result.errors).toEqual([]);
      expect(readFileSync(join(audioRoot, `02-a.${ext}`), 'utf8')).toBe('audio-bytes:01-a');
      expect(readFileSync(join(audioRoot, `01-b.${ext}`), 'utf8')).toBe('audio-bytes:02-b');
      expect(existsSync(join(audioRoot, `01-a.${ext}`))).toBe(false);
      expect(existsSync(join(audioRoot, `02-b.${ext}`))).toBe(false);
    });

    it(`deletes the live .${ext} audio for a delete op`, async () => {
      writeFileSync(join(audioRoot, `05-doomed.${ext}`), 'x');
      writeFileSync(join(audioRoot, '05-doomed.segments.json'), '{}');
      const result = await rewriteChapterSlugs(audioRoot, [{ kind: 'delete', from: '05-doomed' }]);
      expect(result.errors).toEqual([]);
      expect(existsSync(join(audioRoot, `05-doomed.${ext}`))).toBe(false);
      expect(result.deleted.map((d) => d.suffix)).toContain(ext);
    });
  }

  it('tolerates a delete on a slug that has no files (silent no-op)', async () => {
    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'delete', from: '99-never-existed' },
    ]);
    expect(result).toEqual({ renamed: [], deleted: [], errors: [] });
  });

  it('preserves segments.json fields outside chapterId / chapterTitle', async () => {
    seed('02-old', {
      segments: {
        bookId: 'book-x',
        chapterId: 2,
        chapterTitle: 'old',
        durationSec: 123.4,
        modelKey: 'kokoro-v1',
        synthesizedAt: '2026-01-01T00:00:00.000Z',
        segments: [{ groupIndex: 0, characterId: 'narr', sentenceIds: [1, 2], startSec: 0, endSec: 5 }],
      },
    });

    await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '02-old', to: '03-new', newChapterId: 3, newChapterTitle: 'new' },
    ]);

    const seg = JSON.parse(readFileSync(join(audioRoot, '03-new.segments.json'), 'utf8'));
    expect(seg.bookId).toBe('book-x');
    expect(seg.durationSec).toBe(123.4);
    expect(seg.modelKey).toBe('kokoro-v1');
    expect(seg.synthesizedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(seg.segments).toEqual([
      { groupIndex: 0, characterId: 'narr', sentenceIds: [1, 2], startSec: 0, endSec: 5 },
    ]);
  });
});

import { readdirSync } from 'node:fs';
function readDirNames(dir: string): string[] {
  return readdirSync(dir);
}

/* #3400 — the A/B take's `.previous.*` artifacts follow the live audio. */
function seedPrevious(slug: string): void {
  writeFileSync(join(audioRoot, `${slug}.previous.mp3`), `previous-bytes:${slug}`);
  writeFileSync(
    join(audioRoot, `${slug}.previous.segments.json`),
    JSON.stringify({ bookId: 'b', chapterId: 99, chapterTitle: 'OLD', segments: [] }),
  );
}

describe('rewriteChapterSlugs — .previous.* artifacts', () => {
  it('moves a chapter\'s previous take with it on a swap, never leaving it under a slug another chapter now owns', async () => {
    seed('01-a');
    seed('02-b');
    seedPrevious('01-a'); // only chapter A has a previous take

    await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '01-a', to: '02-b', newChapterId: 2, newChapterTitle: 'a' },
      { kind: 'rename', from: '02-b', to: '01-a', newChapterId: 1, newChapterTitle: 'b' },
    ]);

    // A's previous take travelled to A's new slug.
    expect(readFileSync(join(audioRoot, '02-b.previous.mp3'), 'utf8')).toBe('previous-bytes:01-a');
    expect(existsSync(join(audioRoot, '02-b.previous.segments.json'))).toBe(true);
    // B (now 01-a) had no previous take and must not inherit A's.
    expect(existsSync(join(audioRoot, '01-a.previous.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '01-a.previous.segments.json'))).toBe(false);
    // Embedded chapter metadata follows the live segments rewrite.
    const seg = JSON.parse(readFileSync(join(audioRoot, '02-b.previous.segments.json'), 'utf8'));
    expect(seg).toMatchObject({ chapterId: 2, chapterTitle: 'a' });
  });

  it('chain A→B while B→C does not clobber either chapter\'s previous take', async () => {
    seed('01-a');
    seed('02-b');
    seedPrevious('01-a');
    seedPrevious('02-b');

    await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '01-a', to: '02-b', newChapterId: 2, newChapterTitle: 'a' },
      { kind: 'rename', from: '02-b', to: '03-c', newChapterId: 3, newChapterTitle: 'b' },
    ]);

    expect(readFileSync(join(audioRoot, '02-b.previous.mp3'), 'utf8')).toBe('previous-bytes:01-a');
    expect(readFileSync(join(audioRoot, '03-c.previous.mp3'), 'utf8')).toBe('previous-bytes:02-b');
    expect(existsSync(join(audioRoot, '01-a.previous.mp3'))).toBe(false);
  });

  it('deletes the previous take when the chapter\'s audio is deleted (content changed)', async () => {
    seed('01-a');
    seedPrevious('01-a');

    await rewriteChapterSlugs(audioRoot, [{ kind: 'delete', from: '01-a' }]);

    expect(existsSync(join(audioRoot, '01-a.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '01-a.previous.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '01-a.previous.segments.json'))).toBe(false);
  });

  it('a delete whose slug is also a rename target removes the OLD occupant, never the chapter renamed into it (#3400)', async () => {
    seed('03-c');
    seedPrevious('03-c');
    seed('04-d');
    seedPrevious('04-d');

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'delete', from: '03-c' },
      { kind: 'rename', from: '04-d', to: '03-c', newChapterId: 3, newChapterTitle: 'd' },
    ]);

    expect(result.errors).toEqual([]);
    // Renamed chapter's live + previous + segments + peaks landed at the slug...
    expect(readFileSync(join(audioRoot, '03-c.mp3'), 'utf8')).toBe('audio-bytes:04-d');
    expect(readFileSync(join(audioRoot, '03-c.previous.mp3'), 'utf8')).toBe('previous-bytes:04-d');
    expect(existsSync(join(audioRoot, '03-c.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '03-c.peaks.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '03-c.previous.segments.json'))).toBe(true);
    // ...and the deleted chapter's bytes are gone, the source slug vacated.
    expect(existsSync(join(audioRoot, '04-d.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '04-d.previous.mp3'))).toBe(false);
    expect(result.deleted.map((d) => d.slug)).toEqual(Array(5).fill('03-c'));
  });
});

/* #3400 — per-chapter sidecars written next to the audio by finalize
   (`.lufs.json`), the content-QA pass (`.embeddings.json`) and the
   render-integrity scorer (`.render-integrity.json`,
   `.render-integrity-attempted.json`) describe THIS chapter's audio, so they
   must follow it on a slug swap and go with it on a delete. */
const PER_CHAPTER_SIDECARS = [
  'lufs.json',
  'embeddings.json',
  'render-integrity.json',
  'render-integrity-attempted.json',
] as const;

function seedSidecars(slug: string): void {
  for (const suffix of PER_CHAPTER_SIDECARS) {
    writeFileSync(join(audioRoot, `${slug}.${suffix}`), `${suffix}:${slug}`);
  }
}

describe('rewriteChapterSlugs — per-chapter sidecars (#3400)', () => {
  it('swaps two chapters\' loudness/QA sidecars together with their audio', async () => {
    seed('01-a');
    seed('02-b');
    seedSidecars('01-a');
    seedSidecars('02-b');

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '01-a', to: '02-a', newChapterId: 2, newChapterTitle: 'A' },
      { kind: 'rename', from: '02-b', to: '01-b', newChapterId: 1, newChapterTitle: 'B' },
    ]);

    expect(result.errors).toEqual([]);
    for (const suffix of PER_CHAPTER_SIDECARS) {
      expect(readFileSync(join(audioRoot, `02-a.${suffix}`), 'utf8')).toBe(`${suffix}:01-a`);
      expect(readFileSync(join(audioRoot, `01-b.${suffix}`), 'utf8')).toBe(`${suffix}:02-b`);
      expect(existsSync(join(audioRoot, `01-a.${suffix}`))).toBe(false);
      expect(existsSync(join(audioRoot, `02-b.${suffix}`))).toBe(false);
    }
  });

  it('deletes the sidecars when the chapter\'s audio is deleted', async () => {
    seed('05-doomed');
    seedSidecars('05-doomed');

    const result = await rewriteChapterSlugs(audioRoot, [{ kind: 'delete', from: '05-doomed' }]);

    expect(result.errors).toEqual([]);
    for (const suffix of PER_CHAPTER_SIDECARS) {
      expect(existsSync(join(audioRoot, `05-doomed.${suffix}`))).toBe(false);
    }
  });

  it('a delete on a slug that is also a rename source leaves the files to move away intact', async () => {
    seed('01-x');
    seedSidecars('01-x');

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'delete', from: '01-x' },
      { kind: 'rename', from: '01-x', to: '02-y', newChapterId: 2, newChapterTitle: 'Y' },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(audioRoot, '02-y.mp3'), 'utf8')).toBe('audio-bytes:01-x');
    for (const suffix of PER_CHAPTER_SIDECARS) {
      expect(existsSync(join(audioRoot, `02-y.${suffix}`))).toBe(true);
      expect(existsSync(join(audioRoot, `01-x.${suffix}`))).toBe(false);
    }
  });
});
