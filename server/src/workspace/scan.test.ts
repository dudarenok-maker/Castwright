/* Integration tests for scanLibrary's derived book stats: characterCount,
   voiceCount, and runtime. Set WORKSPACE_DIR to a tempdir before importing
   the modules (paths.ts reads it at load time), then scaffold synthetic
   book layouts with varying completeness so each branch in scanBook gets
   exercised. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let scanLibrary: typeof import('./scan.js').scanLibrary;
let makeBookId: typeof import('./paths.js').makeBookId;
let saveAnalysisCache: typeof import('../store/analysis-cache.js').saveAnalysisCache;
let clearAnalysisCache: typeof import('../store/analysis-cache.js').clearAnalysisCache;
/* Track every manuscriptId we seed a cache for so afterAll can sweep them.
   Cache files live at server/handoff/cache/<id>.json — outside the workspace
   tempdir, so the tempdir rmSync won't catch them. */
const seededManuscriptIds: string[] = [];

async function seedAnalysisCache(manuscriptId: string, chapterIds: number[]): Promise<void> {
  const chapters: Record<number, []> = {};
  for (const id of chapterIds) chapters[id] = [];
  await saveAnalysisCache(manuscriptId, { chapters });
  seededManuscriptIds.push(manuscriptId);
}

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';

function bookSkeleton(
  title: string,
  opts: {
    castConfirmed?: boolean;
    chapters?: Array<{ id: number; slug: string }>;
  } = {},
) {
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  const chapters = opts.chapters ?? [{ id: 1, slug: 'chapter-one' }];
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: !!opts.castConfirmed,
      chapters: chapters.map((c) => ({ id: c.id, title: `Chapter ${c.id}`, slug: c.slug })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return { bookId, bookDir, audioRoot };
}

function writeCast(bookDir: string, characters: Array<{ id: string; voiceId?: string }>) {
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

function writeSegments(audioRoot: string, slug: string, durationSec: number) {
  writeFileSync(
    join(audioRoot, `${slug}.segments.json`),
    JSON.stringify({
      bookId: 'unused',
      chapterId: 1,
      chapterTitle: 'unused',
      durationSec,
      sampleRate: 24_000,
      modelKey: 'xtts_v2',
      synthesizedAt: new Date().toISOString(),
      segments: [],
    }),
  );
}

function flatten() {
  /* Convenience: scanLibrary returns the 3-level hierarchy; tests assert
     on a flat list since each test fixture only writes one book per case. */
  return scanLibrary().then((r) => r.authors.flatMap((a) => a.series.flatMap((s) => s.books)));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-scan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Defer module load so paths.ts picks up WORKSPACE_DIR. */
  const scan = await import('./scan.js');
  const paths = await import('./paths.js');
  const cache = await import('../store/analysis-cache.js');
  scanLibrary = scan.scanLibrary;
  makeBookId = paths.makeBookId;
  saveAnalysisCache = cache.saveAnalysisCache;
  clearAnalysisCache = cache.clearAnalysisCache;
});

afterAll(async () => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  /* Clean up any cache fixtures we seeded — they live outside the tempdir
     in server/handoff/cache/ and would otherwise leak across runs. */
  for (const id of seededManuscriptIds) {
    await clearAnalysisCache(id).catch(() => {});
  }
  seededManuscriptIds.length = 0;
});

describe('scanLibrary derived stats', () => {
  it('analysing book (state-only, no cast) reports zero voices/characters and no runtime', async () => {
    bookSkeleton('Analysing Book');
    const books = await flatten();
    const b = books.find((x) => x.title === 'Analysing Book')!;
    expect(b.status).toBe('analysing');
    expect(b.characterCount).toBe(0);
    expect(b.voiceCount).toBe(0);
    expect(b.voiceIds).toEqual([]);
    expect(b.runtime).toBeUndefined();
  });

  it('cast_pending book reports cast counts but no runtime (no audio yet)', async () => {
    const { bookDir, bookId } = bookSkeleton('Cast Pending Book');
    /* Cast file alone isn't enough — the per-chapter analysis cache must
       also be complete or scanBook treats the book as still analysing. */
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeCast(bookDir, [
      { id: 'narrator' },
      { id: 'marlow', voiceId: 'voice-warm-male' },
      { id: 'wren', voiceId: 'voice-bright-young' },
    ]);
    const books = await flatten();
    const b = books.find((x) => x.title === 'Cast Pending Book')!;
    expect(b.status).toBe('cast_pending');
    expect(b.characterCount).toBe(3);
    expect(b.voiceCount).toBe(3);
    expect(b.runtime).toBeUndefined();
  });

  it('characters sharing a voiceId collapse into one voice slot', async () => {
    const { bookDir, bookId } = bookSkeleton('Shared Voice Book');
    await seedAnalysisCache(`m_${bookId}`, [1]);
    /* Both Hespa and Corvin use the library voice 'voice-elder-female' →
       voiceCount must be 2 (narrator + the shared voice), not 3. */
    writeCast(bookDir, [
      { id: 'narrator' },
      { id: 'hespa', voiceId: 'voice-elder-female' },
      { id: 'corvin', voiceId: 'voice-elder-female' },
    ]);
    const books = await flatten();
    const b = books.find((x) => x.title === 'Shared Voice Book')!;
    expect(b.characterCount).toBe(3);
    expect(b.voiceCount).toBe(2);
    /* voiceIds exposes the same deduped set (voiceId ?? id) so the library
       view can union across books for a distinct-voices total. The narrator
       has no voiceId, so it contributes its id. */
    expect([...b.voiceIds].sort()).toEqual(['narrator', 'voice-elder-female']);
  });

  it('complete book sums per-chapter segments.json into a formatted runtime', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Complete Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'ch-01' },
        { id: 2, slug: 'ch-02' },
        { id: 3, slug: 'ch-03' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2, 3]);
    writeCast(bookDir, [{ id: 'narrator' }, { id: 'marlow', voiceId: 'voice-warm-male' }]);
    /* 1500 + 1500 + 600 = 3600 sec = 60 min = '1h 0m' */
    writeSegments(audioRoot, 'ch-01', 1500);
    writeSegments(audioRoot, 'ch-02', 1500);
    writeSegments(audioRoot, 'ch-03', 600);
    /* Audio files must exist for status → complete (matches audioDir filter
       in scan.ts:175). Content can be empty — the scanner only counts. */
    writeFileSync(join(audioRoot, 'ch-01.mp3'), '');
    writeFileSync(join(audioRoot, 'ch-02.mp3'), '');
    writeFileSync(join(audioRoot, 'ch-03.mp3'), '');

    const books = await flatten();
    const b = books.find((x) => x.title === 'Complete Book')!;
    expect(b.status).toBe('complete');
    expect(b.characterCount).toBe(2);
    expect(b.voiceCount).toBe(2);
    expect(b.runtime).toBe('1h 0m');
  });

  it('runtime under one hour formats as Xm only', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Short Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'only-ch' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'only-ch', 47 * 60); // 47 min
    writeFileSync(join(audioRoot, 'only-ch.mp3'), '');
    const books = await flatten();
    const b = books.find((x) => x.title === 'Short Book')!;
    expect(b.runtime).toBe('47m');
  });

  it('partially-generated book sums only the chapters with segments on disk', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Partial Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'p-01' },
        { id: 2, slug: 'p-02' },
        { id: 3, slug: 'p-03' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2, 3]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    /* Only chapter 1 has been generated. Runtime reports just that chapter's
       duration instead of waiting for the whole book. */
    writeSegments(audioRoot, 'p-01', 30 * 60); // 30 min
    writeFileSync(join(audioRoot, 'p-01.mp3'), '');
    const books = await flatten();
    const b = books.find((x) => x.title === 'Partial Book')!;
    expect(b.status).toBe('generating');
    expect(b.runtime).toBe('30m');
  });

  it('malformed cast.json leaves counts at 0 without breaking the scan', async () => {
    const { bookDir, bookId } = bookSkeleton('Broken Cast Book');
    /* Seed a complete analysis cache so the partial-cache branch doesn't
       mask the cast.json branch we're actually testing. */
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), '{not valid json');
    const books = await flatten();
    const b = books.find((x) => x.title === 'Broken Cast Book')!;
    /* Book row still renders; counts stay at 0 (the badge will show '—').
       Status falls back to 'analysing' — there's nothing to confirm on an
       unparseable cast file. */
    expect(b.status).toBe('analysing');
    expect(b.characterCount).toBe(0);
    expect(b.voiceCount).toBe(0);
  });

  it('empty cast.json (characters: []) reports analysing, not cast_pending', async () => {
    /* Regression: an aborted/reset analysis can leave behind a cast.json
       whose characters array is empty. Previously the scanner saw the file
       and flipped the badge to "Cast confirmation" — but there's nothing
       to confirm. Surface it as 'analysing' so re-opening the book routes
       back to the analysing view to finish the run. */
    const { bookDir, bookId } = bookSkeleton('Empty Cast Book');
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    const books = await flatten();
    const b = books.find((x) => x.title === 'Empty Cast Book')!;
    expect(b.status).toBe('analysing');
    expect(b.characterCount).toBe(0);
    expect(b.voiceCount).toBe(0);
  });

  it('partial analysis cache (cast.json present, some chapters un-analysed) reports analysing with resume progress', async () => {
    /* Regression: a run that crashes / is killed midway can leave cast.json
       behind from a prior attempt while only some chapters made it into the
       analysis cache. Without cross-checking the cache the scanner would
       call this cast_pending and route the user to a confirm screen that
       silently drops the un-analysed chapters. Status must stay 'analysing'
       and surface a progress fraction matching the cache so the analysing
       view's progress bar resumes where it left off. */
    const { bookDir, bookId } = bookSkeleton('Half-Done Book', {
      chapters: [
        { id: 1, slug: 'h-01' },
        { id: 2, slug: 'h-02' },
        { id: 3, slug: 'h-03' },
        { id: 4, slug: 'h-04' },
      ],
    });
    /* 2 of 4 chapters analysed. */
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }, { id: 'marlow', voiceId: 'voice-warm-male' }]);
    const books = await flatten();
    const b = books.find((x) => x.title === 'Half-Done Book')!;
    expect(b.status).toBe('analysing');
    expect(b.progress).toBeCloseTo(0.5, 5);
  });

  it('excluded chapters do not count against analysis completion', async () => {
    /* If the user excluded chapters 1 + 2 (front-matter) and the analyser
       only ran on 3 + 4, that IS complete — excluded chapters never enter
       the cache. The scanner must use the active chapter list, not the
       raw chapter list, when judging whether analysis is done. */
    const { bookDir, bookId } = bookSkeleton('Excluded-Heavy Book', {
      chapters: [
        { id: 1, slug: 'x-01' },
        { id: 2, slug: 'x-02' },
        { id: 3, slug: 'x-03' },
        { id: 4, slug: 'x-04' },
      ],
    });
    /* Mark chapters 1 + 2 as excluded by rewriting state.json — the helper
       didn't take an excluded option, and adding one for one test isn't
       worth widening its surface. */
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId: `m_${bookId}`,
        title: 'Excluded-Heavy Book',
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: false,
        chapters: [
          { id: 1, title: 'Chapter 1', slug: 'x-01', excluded: true },
          { id: 2, title: 'Chapter 2', slug: 'x-02', excluded: true },
          { id: 3, title: 'Chapter 3', slug: 'x-03' },
          { id: 4, title: 'Chapter 4', slug: 'x-04' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    /* Cache covers only the active chapters (3 + 4). */
    await seedAnalysisCache(`m_${bookId}`, [3, 4]);
    writeCast(bookDir, [{ id: 'narrator' }, { id: 'marlow', voiceId: 'voice-warm-male' }]);
    const books = await flatten();
    const b = books.find((x) => x.title === 'Excluded-Heavy Book')!;
    expect(b.status).toBe('cast_pending');
    expect(b.chapterCount).toBe(2);
  });

  it('malformed segments.json is skipped without breaking the runtime total', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Mixed Segments Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'ms-01' },
        { id: 2, slug: 'ms-02' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'ms-01', 600);
    writeFileSync(join(audioRoot, 'ms-02.segments.json'), '{not valid');
    writeFileSync(join(audioRoot, 'ms-01.mp3'), '');
    writeFileSync(join(audioRoot, 'ms-02.mp3'), '');
    const books = await flatten();
    const b = books.find((x) => x.title === 'Mixed Segments Book')!;
    /* Only ms-01's 10 minutes is counted; ms-02's bad JSON doesn't poison
       the whole row. */
    expect(b.runtime).toBe('10m');
  });
});

describe('scanLibrary backfills audioModelKey from segments.json', () => {
  /* Regression for the engine-drift feature (plan 35). A book rendered
     before the audioModelKey/audioRenderedAt fields landed in state.json
     should have those fields lazy-migrated from each chapter's segments
     file on the next scan. The disk write is idempotent so subsequent
     scans on a fully-backfilled book are free. */
  it('upgrades state.json with audioModelKey + audioRenderedAt when missing', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Pre-Drift Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'pd-01' },
        { id: 2, slug: 'pd-02' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    /* writeSegments writes modelKey 'xtts_v2' + a fresh synthesizedAt
       — both audio files present so the chapter counts as rendered. */
    writeSegments(audioRoot, 'pd-01', 120);
    writeSegments(audioRoot, 'pd-02', 240);
    writeFileSync(join(audioRoot, 'pd-01.mp3'), '');
    writeFileSync(join(audioRoot, 'pd-02.mp3'), '');

    await flatten(); // triggers scanBook → backfill writes back

    /* Re-read state.json — both chapters now carry audioModelKey + audioRenderedAt. */
    const fs = await import('node:fs/promises');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    expect(persisted.chapters).toHaveLength(2);
    for (const ch of persisted.chapters) {
      expect(ch.audioModelKey).toBe('xtts_v2');
      expect(typeof ch.audioRenderedAt).toBe('string');
      expect(ch.audioRenderedAt.length).toBeGreaterThan(0);
    }
  });

  it('leaves an already-stamped chapter untouched and does not bump updatedAt', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Already-Stamped Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'as-01' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'as-01', 60);
    writeFileSync(join(audioRoot, 'as-01.mp3'), '');

    /* Pre-stamp the chapter with a DIFFERENT engine than the segments
       file claims. The backfill should NOT overwrite an existing stamp
       — once written it's authoritative until the chapter regenerates. */
    const fs = await import('node:fs/promises');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    before.chapters[0].audioModelKey = 'kokoro-v1';
    before.chapters[0].audioRenderedAt = '2026-01-01T00:00:00.000Z';
    const beforeUpdatedAt = before.updatedAt;
    await fs.writeFile(statePath, JSON.stringify(before));

    await flatten();

    const after = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    /* Existing stamp wins. */
    expect(after.chapters[0].audioModelKey).toBe('kokoro-v1');
    expect(after.chapters[0].audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
    /* updatedAt wasn't bumped because no backfill was needed. The whole
       file is byte-identical to `before`, but at minimum updatedAt must
       not change. */
    expect(after.updatedAt).toBe(beforeUpdatedAt);
  });

  it('does not touch state.json when no chapters need backfilling and all are already stamped', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('All-Stamped Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'ast-01' },
        { id: 2, slug: 'ast-02' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'ast-01', 60);
    writeSegments(audioRoot, 'ast-02', 60);
    writeFileSync(join(audioRoot, 'ast-01.mp3'), '');
    writeFileSync(join(audioRoot, 'ast-02.mp3'), '');

    const fs = await import('node:fs/promises');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    for (const ch of before.chapters) {
      ch.audioModelKey = 'xtts_v2';
      ch.audioRenderedAt = '2026-04-01T00:00:00.000Z';
      /* Stamp duration too so the new duration-backfill leg doesn't
         trigger a rewrite — same "everything already migrated" shape. */
      ch.duration = '01:00';
      /* srv-35 — stamp a uuid so the lazy uuid backfill has nothing to
         migrate either; keeps the "everything already migrated" shape. */
      ch.uuid = `u-${ch.id}`;
    }
    await fs.writeFile(statePath, JSON.stringify(before));
    const beforeContent = await fs.readFile(statePath, 'utf-8');

    await flatten();

    /* Steady-state read: no chapter needs backfilling, so state.json
       is byte-identical to before. This pins the "free idempotent
       repeat" property of the migration helper. */
    const afterContent = await fs.readFile(statePath, 'utf-8');
    expect(afterContent).toBe(beforeContent);
  });

  /* Regression for the duration-backfill bug: chapters whose audio rendered
     before the per-chapter `duration` state.json write block landed (or
     under a code path that updates audioModelKey/audioRenderedAt without
     duration — see scan.ts lazy migration) sit at the analysis-seeded
     '00:00' string even though the segments file beside the MP3 carries
     the real PCM duration. The Listen view chapter rows pick that up
     from state.json on hydrate and display 00:00 next to a fully-rendered
     chapter. Backfill closes the loop on the next scan. */
  it('backfills chapter.duration from segments.json when 00:00 / missing', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Zero-Duration Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'zd-01' },
        { id: 2, slug: 'zd-02' },
      ],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'zd-01', 490.048); // → '08:10'
    writeSegments(audioRoot, 'zd-02', 768); // → '12:48'
    writeFileSync(join(audioRoot, 'zd-01.mp3'), '');
    writeFileSync(join(audioRoot, 'zd-02.mp3'), '');

    /* Pre-stamp duration='00:00' on ch1, leave ch2 with duration undefined.
       Both should be backfilled — the bug case from the field had a mix of
       these two unset shapes. */
    const fs = await import('node:fs/promises');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    before.chapters[0].duration = '00:00';
    /* ch2 has no `duration` field at all — bookSkeleton omits it by default */
    await fs.writeFile(statePath, JSON.stringify(before));

    await flatten();

    const after = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    expect(after.chapters[0].duration).toBe('08:10');
    expect(after.chapters[1].duration).toBe('12:48');
  });

  it('leaves a chapter with a real duration alone — segments.json must not overwrite a user-visible value', async () => {
    /* Regression: if a chapter's state.json `duration` is a non-placeholder
       string ('11:14') and its segments.json carries a slightly different
       durationSec (e.g. encode-vs-PCM rounding could make these differ by
       a few seconds in either direction), backfill must NOT clobber the
       state.json value. The duration field is sticky once written —
       regeneration is the only path allowed to change it. */
    const { bookDir, audioRoot, bookId } = bookSkeleton('Sticky-Duration Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'sd-01' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'sd-01', 670); // segments would format as '11:10'
    writeFileSync(join(audioRoot, 'sd-01.mp3'), '');

    const fs = await import('node:fs/promises');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const before = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    before.chapters[0].duration = '11:14'; // user-visible value, different from segments
    before.chapters[0].audioModelKey = 'kokoro-v1';
    before.chapters[0].audioRenderedAt = '2026-05-22T00:00:00.000Z';
    await fs.writeFile(statePath, JSON.stringify(before));

    await flatten();

    const after = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    expect(after.chapters[0].duration).toBe('11:14');
  });
});
