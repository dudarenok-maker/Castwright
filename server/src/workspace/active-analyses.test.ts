/* Integration tests for the workspace-wide active-analyses scan.
 *
 * Mirrors the WORKSPACE_DIR-tempdir bootstrap pattern from scan.test.ts:
 * point paths.ts at a fresh temp workspace before importing the
 * scanner, then scaffold synthetic books with varying analysis-state
 * snapshots.
 *
 * Pins:
 * - Books without an analysis-state.json are silently skipped.
 * - Books WITH a snapshot are included with bookTitle / bookId from
 *   state.json, and the snapshot fields are passed through.
 * - Disk `running` is coerced to wire `paused` (no live in-flight job
 *   means the analyzer didn't survive the restart).
 * - `halted` stays `halted`.
 * - Results are sorted by writtenAt DESC (freshest first), so the
 *   cold-boot pill always picks the most-recent.
 * - A book whose snapshot exists but whose state.json is missing /
 *   malformed is silently skipped (inconsistent workspace shouldn't
 *   500 the whole scan).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let scanActiveAnalyses: typeof import('./active-analyses.js').scanActiveAnalyses;
let makeBookId: typeof import('./paths.js').makeBookId;

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';

function bookSkeleton(
  title: string,
  opts: {
    snapshot?: {
      manuscriptId?: string;
      phaseId?: number;
      phaseLabel?: string;
      phaseProgress?: number;
      state: 'running' | 'paused' | 'halted';
      writtenAt: number;
      lastTickAt?: number;
      kind?: 'main' | 'subset';
      subsetChapterIds?: number[];
      haltCode?: string;
      haltReason?: string;
      engine?: 'local' | 'gemini';
    };
    /** When set, write the snapshot but skip the state.json — to exercise
        the "inconsistent workspace, silently skip" branch. */
    suppressStateJson?: boolean;
  } = {},
): { bookId: string; bookDir: string } {
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  if (!opts.suppressStateJson) {
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
        castConfirmed: false,
        chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }
  if (opts.snapshot) {
    const snap = {
      manuscriptId: opts.snapshot.manuscriptId ?? `m_${bookId}`,
      phaseId: opts.snapshot.phaseId ?? 1,
      phaseLabel: opts.snapshot.phaseLabel ?? 'Parsing and attribution',
      phaseProgress: opts.snapshot.phaseProgress ?? 0.42,
      state: opts.snapshot.state,
      kind: opts.snapshot.kind,
      subsetChapterIds: opts.snapshot.subsetChapterIds,
      haltCode: opts.snapshot.haltCode,
      haltReason: opts.snapshot.haltReason,
      engine: opts.snapshot.engine,
      lastTickAt: opts.snapshot.lastTickAt ?? opts.snapshot.writtenAt,
      writtenAt: opts.snapshot.writtenAt,
    };
    writeFileSync(join(bookDir, '.audiobook', 'analysis-state.json'), JSON.stringify(snap));
  }
  return { bookId, bookDir };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-active-analyses-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const mod = await import('./active-analyses.js');
  const paths = await import('./paths.js');
  scanActiveAnalyses = mod.scanActiveAnalyses;
  makeBookId = paths.makeBookId;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  /* Sweep books/ between cases so each test gets a clean tree without
     re-creating the whole tempdir (which would invalidate paths.ts's
     cached BOOKS_ROOT — that's resolved once at module load). */
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

describe('scanActiveAnalyses', () => {
  it('returns an empty list when no books have analysis-state.json on disk', async () => {
    bookSkeleton('Fresh Book');
    /* Book exists with state.json but no snapshot — should be silently
       skipped. */
    const snaps = await scanActiveAnalyses();
    expect(snaps).toEqual([]);
  });

  it('returns one summary per book that has a snapshot, with bookTitle from state.json', async () => {
    bookSkeleton('Skipped Book');
    bookSkeleton('Paused Book', {
      snapshot: {
        state: 'paused',
        phaseProgress: 0.55,
        writtenAt: 100,
      },
    });
    const snaps = await scanActiveAnalyses();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].bookTitle).toBe('Paused Book');
    expect(snaps[0].bookId).toBe(makeBookId(AUTHOR, SERIES, 'Paused Book'));
    expect(snaps[0].state).toBe('paused');
    expect(snaps[0].phaseProgress).toBeCloseTo(0.55);
  });

  it('coerces disk `running` to wire `paused` (no live job means the analyzer is gone)', async () => {
    bookSkeleton('Was Running Book', {
      snapshot: { state: 'running', writtenAt: 200 },
    });
    const [snap] = await scanActiveAnalyses();
    expect(snap.state).toBe('paused');
  });

  it('passes `halted` through unchanged', async () => {
    bookSkeleton('Halted Book', {
      snapshot: {
        state: 'halted',
        writtenAt: 200,
        haltCode: 'attribution_drift',
        haltReason: 'too many drift markers',
      },
    });
    const [snap] = await scanActiveAnalyses();
    expect(snap.state).toBe('halted');
    expect(snap.haltCode).toBe('attribution_drift');
    expect(snap.haltReason).toBe('too many drift markers');
  });

  it('sorts results by writtenAt DESC so the freshest snapshot is index 0', async () => {
    bookSkeleton('Oldest', { snapshot: { state: 'paused', writtenAt: 100 } });
    bookSkeleton('Newest', { snapshot: { state: 'paused', writtenAt: 300 } });
    bookSkeleton('Middle', { snapshot: { state: 'paused', writtenAt: 200 } });
    const snaps = await scanActiveAnalyses();
    expect(snaps.map((s) => s.bookTitle)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('silently skips a book whose snapshot exists but state.json is missing', async () => {
    /* Inconsistent on-disk state shouldn't 500 the whole library scan.
       Anchor: write a real book first (so the scan has something to find),
       then write a second book with only the snapshot and no state.json. */
    bookSkeleton('Real Book', { snapshot: { state: 'paused', writtenAt: 100 } });
    bookSkeleton('Orphan Book', {
      snapshot: { state: 'paused', writtenAt: 200 },
      suppressStateJson: true,
    });
    const snaps = await scanActiveAnalyses();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].bookTitle).toBe('Real Book');
  });

  it('silently skips a book whose snapshot file is malformed JSON', async () => {
    const { bookDir } = bookSkeleton('Real Book', {
      snapshot: { state: 'paused', writtenAt: 100 },
    });
    bookSkeleton('Corrupt Book');
    /* Hand-write a corrupt snapshot — must NOT crash the whole scan. */
    writeFileSync(
      join(bookDir, '..', 'Corrupt Book', '.audiobook', 'analysis-state.json'),
      '{ not valid json',
    );
    const snaps = await scanActiveAnalyses();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].bookTitle).toBe('Real Book');
    /* Avoid leaking the corrupt file across cases (beforeEach sweeps anyway). */
    const corrupt = join(bookDir, '..', 'Corrupt Book', '.audiobook', 'analysis-state.json');
    if (existsSync(corrupt)) unlinkSync(corrupt);
  });

  it('carries kind / subsetChapterIds / engine through verbatim', async () => {
    bookSkeleton('Subset Retry Book', {
      snapshot: {
        state: 'paused',
        writtenAt: 100,
        kind: 'subset',
        subsetChapterIds: [4, 7, 11],
        engine: 'local',
      },
    });
    const [snap] = await scanActiveAnalyses();
    expect(snap.kind).toBe('subset');
    expect(snap.subsetChapterIds).toEqual([4, 7, 11]);
    expect(snap.engine).toBe('local');
  });
});
