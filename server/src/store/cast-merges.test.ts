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

  it('replaceDedupEntries swaps dedup entries but preserves fold + manual', async () => {
    const { replaceDedupEntries } = await import('./cast-merges.js');
    const base = {
      entries: [
        { ts: 't', kind: 'manual' as const, sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
        { ts: 't', kind: 'fold' as const, sourceId: 'c', sourceName: 'C', targetId: 'd', affected: [] },
        { ts: 't', kind: 'dedup' as const, sourceId: 'olga', sourceName: 'Ольга', targetId: 'ольга', affected: [] },
      ],
    };
    const next = replaceDedupEntries(base, [
      { ts: 't2', kind: 'dedup' as const, sourceId: 'ilya', sourceName: 'Илья', targetId: 'илья', affected: [] },
    ]);
    expect(next.entries.filter((e) => e.kind === 'manual')).toHaveLength(1);
    expect(next.entries.filter((e) => e.kind === 'fold')).toHaveLength(1);
    expect(next.entries.filter((e) => e.kind === 'dedup')).toEqual([
      { ts: 't2', kind: 'dedup', sourceId: 'ilya', sourceName: 'Илья', targetId: 'илья', affected: [] },
    ]);
  });

  it('buildDedupJournalEntries records pre-dedup affected sentences + sourceName', async () => {
    const { buildDedupJournalEntries } = await import('./cast-merges.js');
    const rewrites = { olga: 'ольга' };
    const preDedupSentences = [
      { id: 1, chapterId: 3, characterId: 'olga' },
      { id: 2, chapterId: 3, characterId: 'antonio' },
      { id: 5, chapterId: 4, characterId: 'olga' },
    ];
    const chars = [{ id: 'olga', name: 'Ольга' }, { id: 'ольга', name: 'Ольга' }];
    const entries = buildDedupJournalEntries(rewrites, preDedupSentences, chars, 'TS');
    expect(entries).toEqual([
      {
        ts: 'TS',
        kind: 'dedup',
        sourceId: 'olga',
        sourceName: 'Ольга',
        targetId: 'ольга',
        affected: [{ chapterId: 3, sentenceId: 1 }, { chapterId: 4, sentenceId: 5 }],
      },
    ]);
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

  /* Replaces the deleted `clearCastMerges` test: Start fresh no longer removes the
     journal (plan 291 rule 8, #4031); it clears every entry's refs and keeps the merges. */
  it("clearAffectedRefs empties every entry's refs of every kind and keeps the merges", async () => {
    const { loadCastMerges, saveCastMerges, clearAffectedRefs } = await import('./cast-merges.js');
    const refs = [{ chapterId: 3, sentenceId: 4 }];
    await saveCastMerges(bookDir, {
      entries: (['manual', 'fold', 'dedup'] as const).map((kind) => ({
        ts: 't',
        kind,
        sourceId: `${kind}-src`,
        sourceName: kind,
        targetId: 'b',
        affected: refs.map((r) => ({ ...r })),
      })),
    });
    await clearAffectedRefs(bookDir);
    const after = await loadCastMerges(bookDir);
    expect(after.entries.map((e) => [e.kind, e.sourceId, e.sourceName, e.targetId, e.ts])).toEqual([
      ['manual', 'manual-src', 'manual', 'b', 't'],
      ['fold', 'fold-src', 'fold', 'b', 't'],
      ['dedup', 'dedup-src', 'dedup', 'b', 't'],
    ]);
    expect(after.entries.map((e) => e.affected)).toEqual([[], [], []]);
  });

  it('clearAffectedRefs writes nothing when the journal is absent or carries no refs', async () => {
    const { loadCastMerges, saveCastMerges, clearAffectedRefs, castMergesExists } = await import(
      './cast-merges.js'
    );
    const { castMergesJsonPath } = await import('../workspace/paths.js');
    rmSync(castMergesJsonPath(bookDir), { force: true });
    await clearAffectedRefs(bookDir);
    expect(await castMergesExists(bookDir)).toBe(false);
    await saveCastMerges(bookDir, {
      entries: [
        { ts: 't', kind: 'manual', sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
      ],
    });
    const { statSync, utimesSync } = await import('node:fs');
    /* Back-date the file so a rewrite cannot hide inside the clock's resolution. */
    utimesSync(castMergesJsonPath(bookDir), 1000, 1000);
    await clearAffectedRefs(bookDir);
    expect(statSync(castMergesJsonPath(bookDir)).mtimeMs).toBe(1_000_000);
    expect((await loadCastMerges(bookDir)).entries).toHaveLength(1);
  });
});
