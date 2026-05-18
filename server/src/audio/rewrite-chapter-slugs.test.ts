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
