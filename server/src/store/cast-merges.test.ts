/* Unit tests for the cast-merges journal store: the pure transform helpers
   (no IO) plus a load/save/clear round-trip against a tempdir workspace. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cast-merges store — pure helpers', () => {
  it('buildFoldJournalEntries maps a multi-source rewrite to chapter-qualified affected sets', async () => {
    const { buildFoldJournalEntries } = await import('./cast-merges.js');
    const rewrites = { garrow: 'unknown-male', mott: 'unknown-male' };
    const preFold = [
      { id: 5, chapterId: 7, characterId: 'garrow', text: 'a' },
      { id: 3, chapterId: 8, characterId: 'garrow', text: 'b' },
      { id: 1, chapterId: 2, characterId: 'mott', text: 'c' },
      { id: 9, chapterId: 2, characterId: 'narrator', text: 'd' },
    ];
    const characters = [
      { id: 'garrow', name: 'Garrow' },
      { id: 'mott', name: 'Mott' },
      { id: 'narrator', name: 'Narrator' },
    ];
    const entries = buildFoldJournalEntries(
      rewrites,
      preFold,
      characters,
      '2026-06-14T00:00:00.000Z',
    );

    expect(entries).toHaveLength(2);
    const garrow = entries.find((e) => e.sourceId === 'garrow')!;
    expect(garrow).toMatchObject({
      kind: 'fold',
      sourceId: 'garrow',
      sourceName: 'Garrow',
      targetId: 'unknown-male',
      ts: '2026-06-14T00:00:00.000Z',
    });
    expect(garrow.affected).toEqual([
      { chapterId: 7, sentenceId: 5 },
      { chapterId: 8, sentenceId: 3 },
    ]);
    const mott = entries.find((e) => e.sourceId === 'mott')!;
    expect(mott.affected).toEqual([{ chapterId: 2, sentenceId: 1 }]);
  });

  it('buildFoldJournalEntries returns [] for an empty rewrite map', async () => {
    const { buildFoldJournalEntries } = await import('./cast-merges.js');
    expect(buildFoldJournalEntries({}, [], [], '2026-06-14T00:00:00.000Z')).toEqual([]);
  });

  it('replaceFoldEntries drops existing fold entries and keeps manual ones', async () => {
    const { replaceFoldEntries } = await import('./cast-merges.js');
    const file = {
      entries: [
        {
          ts: 't1',
          kind: 'manual' as const,
          sourceId: 'a',
          sourceName: 'A',
          targetId: 'b',
          affected: [],
        },
        {
          ts: 't2',
          kind: 'fold' as const,
          sourceId: 'x',
          sourceName: 'X',
          targetId: 'unknown-male',
          affected: [],
        },
      ],
    };
    const next = replaceFoldEntries(file, [
      {
        ts: 't3',
        kind: 'fold' as const,
        sourceId: 'y',
        sourceName: 'Y',
        targetId: 'unknown-male',
        affected: [],
      },
    ]);
    expect(next.entries.map((e) => `${e.kind}:${e.sourceId}`)).toEqual(['manual:a', 'fold:y']);
  });

  it('appendManualEntry appends without touching existing entries', async () => {
    const { appendManualEntry } = await import('./cast-merges.js');
    const file = { entries: [] };
    const next = appendManualEntry(file, {
      ts: 't1',
      kind: 'manual' as const,
      sourceId: 'a',
      sourceName: 'A',
      targetId: 'b',
      affected: [{ chapterId: 1, sentenceId: 2 }],
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ kind: 'manual', sourceId: 'a' });
  });
});

describe('cast-merges store — IO round-trip', () => {
  let workspaceRoot: string;
  let bookDir: string;

  beforeAll(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merges-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    bookDir = join(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  });

  afterAll(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('loads an empty envelope when the file is absent, then saves and reloads', async () => {
    const { loadCastMerges, saveCastMerges, appendManualEntry } = await import('./cast-merges.js');
    const empty = await loadCastMerges(bookDir);
    expect(empty).toEqual({ entries: [] });

    const saved = appendManualEntry(empty, {
      ts: 't1',
      kind: 'manual',
      sourceId: 'a',
      sourceName: 'A',
      targetId: 'b',
      affected: [{ chapterId: 3, sentenceId: 4 }],
    });
    await saveCastMerges(bookDir, saved);

    const reloaded = await loadCastMerges(bookDir);
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.entries[0].affected).toEqual([{ chapterId: 3, sentenceId: 4 }]);
  });

  it('clearCastMerges removes the file and is a no-op when absent', async () => {
    const { loadCastMerges, saveCastMerges, clearCastMerges, castMergesExists } =
      await import('./cast-merges.js');
    await saveCastMerges(bookDir, {
      entries: [
        { ts: 't', kind: 'manual', sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
      ],
    });
    expect(await castMergesExists(bookDir)).toBe(true);
    await clearCastMerges(bookDir);
    expect(await castMergesExists(bookDir)).toBe(false);
    /* Second clear must not throw. */
    await clearCastMerges(bookDir);
    expect((await loadCastMerges(bookDir)).entries).toEqual([]);
  });
});
