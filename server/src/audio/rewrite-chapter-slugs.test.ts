/* Pin the two-pass rename, segments.json metadata rewrite, and delete
 * semantics of rewriteChapterSlugs (plan 51). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteChapterSlugs } from './rewrite-chapter-slugs.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { applyMerge } from '../workspace/restructure.js';
import type { BookStateJson } from '../workspace/scan.js';

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

  it('moves the render-integrity sidecars (embeddings, verdicts, attempted sentinel) with a renamed chapter and deletes them with a deleted one (#3524)', async () => {
    const sidecars = ['embeddings.json', 'render-integrity.json', 'render-integrity-attempted.json'];
    for (const slug of ['02-old-title', '05-gone']) {
      seed(slug);
      for (const s of sidecars) writeFileSync(join(audioRoot, `${slug}.${s}`), `${s}:${slug}`);
    }

    const result = await rewriteChapterSlugs(audioRoot, [
      { kind: 'rename', from: '02-old-title', to: '03-new-title', newChapterId: 3, newChapterTitle: 'new' },
      { kind: 'delete', from: '05-gone' },
    ]);

    expect(result.errors).toEqual([]);
    for (const s of sidecars) {
      expect(existsSync(join(audioRoot, `02-old-title.${s}`))).toBe(false);
      expect(readFileSync(join(audioRoot, `03-new-title.${s}`), 'utf8')).toBe(`${s}:02-old-title`);
      expect(existsSync(join(audioRoot, `05-gone.${s}`))).toBe(false);
    }
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

describe('rewriteChapterSlugs per-book audio format (#3524 S2)', () => {
  it.each(['m4a', 'ogg', 'mp3'] as const)(
    'a renamed %s chapter keeps its audio and lufs.json and findChapterAudio finds it at the new slug',
    async (ext) => {
      writeFileSync(join(audioRoot, `03-x.${ext}`), `audio:${ext}`);
      writeFileSync(join(audioRoot, '03-x.lufs.json'), JSON.stringify({ integrated: -18 }));
      writeFileSync(join(audioRoot, '03-x.segments.json'), JSON.stringify({ segments: [] }));

      const result = await rewriteChapterSlugs(audioRoot, [
        { kind: 'rename', from: '03-x', to: '02-x', newChapterId: 2, newChapterTitle: 'X' },
      ]);

      expect(result.errors).toEqual([]);
      expect(findChapterAudio(audioRoot, '02-x')?.ext).toBe(ext);
      expect(readFileSync(join(audioRoot, `02-x.${ext}`), 'utf8')).toBe(`audio:${ext}`);
      expect(existsSync(join(audioRoot, '02-x.lufs.json'))).toBe(true);
      expect(readdirSync(audioRoot).filter((n) => n.startsWith('03-x'))).toEqual([]);
    },
  );

  it('a delete op removes the m4a/ogg audio and lufs.json too', async () => {
    for (const f of ['05-gone.m4a', '05-gone.ogg', '05-gone.lufs.json']) {
      writeFileSync(join(audioRoot, f), 'x');
    }
    await rewriteChapterSlugs(audioRoot, [{ kind: 'delete', from: '05-gone' }]);
    expect(readdirSync(audioRoot)).toEqual([]);
  });
});

describe('rewriteChapterSlugs x applyMerge (#3524 S1)', () => {
  it('a merge that renumbers app-made titles never deletes the files a rename just moved into the deleted slug', async () => {
    const titles = [1, 2, 3, 4, 5].map((n) => `Chapter ${n}`);
    const slugOf = (id: number, title: string) =>
      `${String(id).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const state = {
      bookId: 'b',
      manuscriptId: 'm',
      title: 'T',
      author: 'A',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: titles.map((title, i) => ({
        id: i + 1,
        title,
        slug: slugOf(i + 1, title),
        titleSynthesized: true,
        audioRenderedAt: '2026-01-01T00:00:00.000Z',
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as BookStateJson;
    const hints = titles.map((title, i) => ({ id: i + 1, title, body: `body ${i + 1}` }));
    const suffixes = [
      'mp3',
      'segments.json',
      'peaks.json',
      'embeddings.json',
      'render-integrity.json',
      'render-integrity-attempted.json',
    ];
    for (const c of state.chapters) {
      for (const s of suffixes) {
        const tag = `${s}:${c.slug}`;
        writeFileSync(join(audioRoot, `${c.slug}.${s}`), s === 'mp3' ? tag : JSON.stringify({ tag }));
      }
    }

    const merged = applyMerge(state, hints, [], { chapterIds: [3, 4] });
    const result = await rewriteChapterSlugs(audioRoot, merged.audioOps);

    expect(result.errors).toEqual([]);
    // Old chapter 5 is now chapter 4: all of its files must have survived the move.
    const newFour = merged.state.chapters.find((c) => c.id === 4)!;
    for (const s of suffixes) {
      const p = join(audioRoot, `${newFour.slug}.${s}`);
      expect(existsSync(p), `${newFour.slug}.${s}`).toBe(true);
      const tag = `${s}:05-chapter-5`;
      expect(readFileSync(p, 'utf8')).toContain(tag);
    }
  });
});

describe('rewriteChapterSlugs x applyMerge with an empty chapter (#3524 N2)', () => {
  it('every rendered chapter keeps its own files at its final slug when the empty-chapter prune renumbers it', async () => {
    const titles = [1, 2, 3, 4, 5].map((n) => `Chapter ${n}`);
    const slugOf = (id: number, title: string) =>
      `${String(id).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const state = {
      bookId: 'b', manuscriptId: 'm', title: 'T', author: 'A', series: 'Standalones', seriesPosition: null,
      isStandalone: true, manuscriptFile: 'manuscript.txt', castConfirmed: false,
      chapters: titles.map((title, i) => ({
        id: i + 1, title, slug: slugOf(i + 1, title), titleSynthesized: true, audioRenderedAt: '2026-01-01T00:00:00.000Z',
      })),
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as BookStateJson;
    const hints = titles.map((title, i) => ({ id: i + 1, title, body: `body ${i + 1}` }));
    // Chapter 2 has no sentences (a heading-only "Part One"), so the prune pass removes it.
    const sentences = [1, 3, 4, 5].map((chapterId, i) => ({ id: i + 1, chapterId, characterId: 'narrator', text: `s${chapterId}` }));
    const suffixes = ['mp3', 'segments.json', 'peaks.json', 'lufs.json', 'embeddings.json'];
    const tagOf = (s: string, slug: string) => `${s}:${slug}`;
    for (const c of state.chapters) {
      for (const s of suffixes) {
        const tag = tagOf(s, c.slug);
        writeFileSync(join(audioRoot, `${c.slug}.${s}`), s === 'mp3' ? tag : JSON.stringify({ tag }));
      }
    }

    const merged = applyMerge(state, hints, sentences, { chapterIds: [4, 5] });
    const result = await rewriteChapterSlugs(audioRoot, merged.audioOps);
    expect(result.errors).toEqual([]);

    const finalChapters = merged.state.chapters;
    expect(finalChapters.map((c) => c.id)).toEqual([1, 2, 3]);
    // Rendered, content-unchanged chapters: old 1 -> 1, old 3 -> 2. Each owns its own old content.
    const ownerOf = new Map([[1, '01-chapter-1'], [2, '03-chapter-3']]);
    for (const [newId, oldSlug] of ownerOf) {
      const ch = finalChapters.find((c) => c.id === newId)!;
      expect(ch.audioRenderedAt).toBeTruthy();
      for (const s of suffixes) {
        const p = join(audioRoot, `${ch.slug}.${s}`);
        expect(existsSync(p), `${ch.slug}.${s}`).toBe(true);
        const body = readFileSync(p, 'utf8');
        expect(s === 'mp3' ? body : (JSON.parse(body) as { tag: string }).tag).toBe(tagOf(s, oldSlug));
      }
    }
    // The merged chapter was not rendered: it must not inherit any chapter's audio.
    const mergedCh = finalChapters.find((c) => c.id === 3)!;
    expect(mergedCh.audioRenderedAt).toBeFalsy();
    expect(readdirSync(audioRoot).filter((n) => n.startsWith(`${mergedCh.slug}.`))).toEqual([]);
    // Nothing is left at the old slugs of the tail.
    expect(readdirSync(audioRoot).sort()).toEqual(
      ['01-chapter-1', '02-chapter-2'].flatMap((sl) => suffixes.map((s) => `${sl}.${s}`)).sort(),
    );
  });
});
function readDirNames(dir: string): string[] {
  return readdirSync(dir);
}
