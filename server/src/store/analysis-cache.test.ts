import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  cachePath,
  clearAnalysisCache,
  loadAnalysisCache,
  mutateAnalysisCache,
  saveAnalysisCache,
  type AnalysisCache,
} from './analysis-cache.js';

describe('cachePath', () => {
  it('throws on a traversal manuscriptId', () => {
    expect(() => cachePath('../../evil')).toThrow();
  });
  it('accepts a normal nanoid manuscriptId', () => {
    expect(() => cachePath('mns_aB3_xY')).not.toThrow();
  });
});

describe('normaliseFailureRecords (via loadAnalysisCache) — untagged legacy records get a phase (spec 2.1)', () => {
  const sentence = [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'A take.' }] as never;
  const stage1 = { characters: [], chapters: [] } as never;
  const rec = (code: string) => ({ code, message: 'm', remediation: 'r' });

  async function roundTrip(seed: Partial<AnalysisCache>): Promise<AnalysisCache> {
    const id = `m_norm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await saveAnalysisCache(id, { chapters: {}, ...seed });
    try {
      return await loadAnalysisCache(id);
    } finally {
      await clearAnalysisCache(id);
    }
  }

  it('normalise: rule-2 residue {attribution-incomplete, cast [], take, no stage1} → cast', async () => {
    const loaded = await roundTrip({
      chapterCast: { 1: [] },
      chapters: { 1: sentence },
      failedChapterIds: [1],
      failedChapterErrors: { '1': rec('attribution-incomplete') },
    });
    expect(loaded.failedChapterErrors?.['1']?.phase).toBe('cast');
  });

  it('normalise: attribution-* with stage1 → attribution', async () => {
    const loaded = await roundTrip({
      stage1,
      chapterCast: { 1: [] },
      chapters: { 1: sentence },
      failedChapterIds: [1],
      failedChapterErrors: { '1': rec('attribution-collapse') },
    });
    expect(loaded.failedChapterErrors?.['1']?.phase).toBe('attribution');
  });

  it('normalise: 06-05 shape (id, no record, non-empty cast) → attribution with synthesised unknown record', async () => {
    const loaded = await roundTrip({
      stage1,
      chapterCast: { 1: [{ id: 'a', name: 'A', role: 'minor', color: 'halloran' }] as never },
      chapters: { 1: sentence },
      failedChapterIds: [1],
    });
    const r = loaded.failedChapterErrors?.['1'];
    expect(r?.phase).toBe('attribution');
    expect(r?.code).toBe('unknown');
    expect(typeof r?.message).toBe('string');
    expect(r?.message.length).toBeGreaterThan(0);
    expect(r?.remediation).toBe('');
  });

  it('normalise: dev-build untagged analyzer-timeout with a cast → attribution', async () => {
    const loaded = await roundTrip({
      stage1,
      chapterCast: { 1: [{ id: 'a', name: 'A', role: 'minor', color: 'halloran' }] as never },
      chapters: { 1: sentence },
      failedChapterIds: [1],
      failedChapterErrors: { '1': rec('analyzer-timeout') },
    });
    expect(loaded.failedChapterErrors?.['1']?.phase).toBe('attribution');
  });

  it('normalise: rule 5 — stage1 present, cast [], a non-attribution code → cast', async () => {
    const loaded = await roundTrip({
      stage1,
      chapterCast: { 1: [] },
      failedChapterIds: [1],
      failedChapterErrors: { '1': rec('analyzer-timeout') },
    });
    expect(loaded.failedChapterErrors?.['1']?.phase).toBe('cast');
  });

  it('normalise: tagged record is never reclassified', async () => {
    /* Shape that rule 2 would call 'cast' (no stage1, empty cast) — a tagged
       'attribution' record must survive untouched. */
    const loaded = await roundTrip({
      chapterCast: { 1: [] },
      failedChapterIds: [1],
      failedChapterErrors: { '1': { ...rec('analyzer-timeout'), phase: 'attribution' } },
    });
    expect(loaded.failedChapterErrors?.['1']?.phase).toBe('attribution');
  });
});

describe('hasCurrentTake (plan 287 spec 2.2)', () => {
  const take = [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'A take.' }] as never;
  const cases: Array<[string, Partial<AnalysisCache>, boolean]> = [
    ['a non-empty take', { chapters: { 1: take } }, true],
    /* Decision B: a [] take is current once attributed, worded or word-free. */
    ['a [] take', { chapters: { 1: [] } }, true],
    ['a pending take', { chapters: { 1: take }, pendingAttributionChapterIds: [1] }, false],
    ['a pending [] take', { chapters: { 1: [] }, pendingAttributionChapterIds: [1] }, false],
    ['no key', { chapters: {} }, false],
  ];
  it.each(cases)('%s', async (_name, seed, expected) => {
    const { hasCurrentTake } = await import('./analysis-cache.js');
    expect(hasCurrentTake({ chapters: {}, ...seed }, 1)).toBe(expected);
  });
});

describe('analysisCompleteFor (plan 287 spec 2.2)', () => {
  const take = [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'A take.' }] as never;
  const stage1 = { characters: [], chapters: [] } as never;
  const done: Partial<AnalysisCache> = { stage1, chapters: { 1: take, 2: [] } };
  const cases: Array<[string, Partial<AnalysisCache>, number[], boolean]> = [
    ['every chapter current, takes persisted (legacy: flag absent)', done, [1, 2], true],
    ['no chapters to analyse', { chapters: {} }, [], true],
    ['missing stage1', { chapters: { 1: take, 2: [] } }, [1, 2], false],
    ['a pending chapter', { ...done, pendingAttributionChapterIds: [2] }, [1, 2], false],
    ['a chapter with no key', { stage1, chapters: { 1: take } }, [1, 2], false],
    ['takesPersisted:false', { ...done, takesPersisted: false }, [1, 2], false],
    ['takesPersisted:true', { ...done, takesPersisted: true }, [1, 2], true],
  ];
  it.each(cases)('%s', async (_name, seed, ids, expected) => {
    const { analysisCompleteFor } = await import('./analysis-cache.js');
    expect(analysisCompleteFor({ chapters: {}, ...seed }, ids)).toBe(expected);
  });
});

describe('reachedConfirm (plan 287 decision F)', () => {
  it('reads castConfirmed or confirmReached', async () => {
    const { reachedConfirm } = await import('./analysis-cache.js');
    expect(reachedConfirm({ castConfirmed: true }, { chapters: {} })).toBe(true);
    expect(reachedConfirm({ castConfirmed: false }, { chapters: {}, confirmReached: true })).toBe(true);
    expect(reachedConfirm({}, { chapters: {} })).toBe(false);
    expect(reachedConfirm(undefined, { chapters: {} })).toBe(false);
  });
});

describe('loadAnalysisCache keeps the plan-287 completeness fields', () => {
  it('round-trips pendingAttributionChapterIds, takesPersisted and confirmReached', async () => {
    const id = `m_flags_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await saveAnalysisCache(id, {
      chapters: {},
      pendingAttributionChapterIds: [3],
      takesPersisted: false,
      confirmReached: true,
    });
    try {
      const loaded = await loadAnalysisCache(id);
      expect(loaded.pendingAttributionChapterIds).toEqual([3]);
      expect(loaded.takesPersisted).toBe(false);
      expect(loaded.confirmReached).toBe(true);
    } finally {
      await clearAnalysisCache(id);
    }
  });
});

/* #4031 / plan 291 Task 6 — the versioned cache and the atomic mutate op. */
describe('versioned analysis cache (#4031)', () => {
  const fresh = () => `m_v2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stage1 = { characters: [], chapters: [] } as never;
  const take = [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'A take.' }] as never;
  const plan = { version: 1 as const, runToken: 'run-1', decisions: {} };
  const dec = (rawId: string, priorId: string) =>
    ({ kind: 'join', rawId, priorId, tier: 'id' }) as const;

  async function withCache<T>(
    seed: Partial<AnalysisCache> | null,
    fn: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = fresh();
    if (seed) await saveAnalysisCache(id, { chapters: {}, ...seed });
    try {
      return await fn(id);
    } finally {
      await clearAnalysisCache(id);
    }
  }

  it('loadAnalysisCache copies version, matchPlan, addedRows and runAddedPairs', async () => {
    await withCache(
      {
        version: 2,
        matchPlan: plan,
        addedRows: { x: { state: 'added-once' } },
        runAddedPairs: [['a', 'b']],
      },
      async (id) => {
        const loaded = await loadAnalysisCache(id);
        expect(loaded.version).toBe(2);
        expect(loaded.matchPlan).toEqual(plan);
        expect(loaded.addedRows).toEqual({ x: { state: 'added-once' } });
        expect(loaded.runAddedPairs).toEqual([['a', 'b']]);
      },
    );
  });

  it('saveAnalysisCache writes version exactly as given', async () => {
    await withCache({ version: 7 }, async (id) => {
      expect((await loadAnalysisCache(id)).version).toBe(7);
    });
    await withCache({}, async (id) => {
      expect((await loadAnalysisCache(id)).version).toBeUndefined();
    });
  });

  describe('classifyAnalysisCache — one case per lifecycle row', () => {
    const cases: Array<[string, Partial<AnalysisCache>, string]> = [
      ['empty', {}, 'empty'],
      ['empty even with a stray version', { version: 2 }, 'empty'],
      ['legacy: not empty, version undefined', { chapters: { 1: take } }, 'legacy'],
      ['legacy: version 1', { version: 1, stage1 }, 'legacy'],
      ['legacy: a future version (R10)', { version: 3, stage1 }, 'legacy'],
      ['current-pre0b', { version: 2, chapterCast: { 1: [] } }, 'current-pre0b'],
      ['current-unplanned', { version: 2, stage1 }, 'current-unplanned'],
      ['current-planned', { version: 2, stage1, matchPlan: plan }, 'current-planned'],
      ['failedChapterIds alone is not empty', { failedChapterIds: [1] }, 'legacy'],
    ];
    it.each(cases)('%s', async (_n, seed, expected) => {
      const { classifyAnalysisCache } = await import('./analysis-cache.js');
      expect(classifyAnalysisCache({ chapters: {}, ...seed })).toBe(expected);
    });
  });

  describe('mutateAnalysisCache', () => {
    it('merges decisions per key', async () => {
      await withCache({ version: 2, stage1 }, async (id) => {
        await mutateAnalysisCache(id, {
          matchPlan: { version: 1, runToken: 'r' },
          decisions: { a: dec('a', 'p1') },
        });
        const out = await mutateAnalysisCache(id, { decisions: { b: dec('b', 'p2') } });
        expect(Object.keys(out?.matchPlan?.decisions ?? {}).sort()).toEqual(['a', 'b']);
        expect(
          Object.keys((await loadAnalysisCache(id)).matchPlan?.decisions ?? {}).sort(),
        ).toEqual(['a', 'b']);
      });
    });

    it('applies chapters (merge/replace), durations, fields, stage1 and ledger deletes', async () => {
      await withCache(
        {
          version: 2,
          chapters: { 1: take, 2: take },
          castDurations: { 1: 5 },
          addedRows: { gone: { state: 'added-once' } },
        },
        async (id) => {
          await mutateAnalysisCache(id, {
            chapters: { 3: take },
            castDurations: { 2: 6 },
            fields: { failedChapterIds: [9] },
            stage1,
            ledger: { gone: null, kept: { state: 'run-owned', fp: 'f' } },
          });
          let c = await loadAnalysisCache(id);
          expect(Object.keys(c.chapters).sort()).toEqual(['1', '2', '3']);
          expect(c.castDurations).toEqual({ 1: 5, 2: 6 });
          expect(c.failedChapterIds).toEqual([9]);
          expect(c.stage1).toBeDefined();
          expect(c.addedRows).toEqual({ kept: { state: 'run-owned', fp: 'f' } });
          await mutateAnalysisCache(id, { chapters: { 7: take }, chaptersMode: 'replace' });
          c = await loadAnalysisCache(id);
          expect(Object.keys(c.chapters)).toEqual(['7']);
        },
      );
    });

    it('clearLedger drops runAddedPairs and run-owned entries but keeps added-once (R4)', async () => {
      await withCache(
        {
          version: 2,
          addedRows: { mine: { state: 'run-owned', fp: 'f' }, sticky: { state: 'added-once' } },
          runAddedPairs: [['a', 'b']],
        },
        async (id) => {
          await mutateAnalysisCache(id, { clearLedger: true });
          const c = await loadAnalysisCache(id);
          expect(c.addedRows).toEqual({ sticky: { state: 'added-once' } });
          expect(c.runAddedPairs).toBeUndefined();
        },
      );
    });

    it('unions runAddedPairs without duplicates', async () => {
      await withCache({ version: 2, runAddedPairs: [['a', 'b']] }, async (id) => {
        await mutateAnalysisCache(id, {
          runAddedPairs: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        });
        expect((await loadAnalysisCache(id)).runAddedPairs).toEqual([
          ['a', 'b'],
          ['c', 'd'],
        ]);
      });
    });

    it('a transform runs atomically on the patched cache (R7)', async () => {
      await withCache({ version: 2, chapters: { 1: take } }, async (id) => {
        const out = await mutateAnalysisCache(id, {
          chapters: { 2: take },
          transform: (c) => ({ ...c, chapters: { 2: c.chapters[2] } }),
        });
        expect(Object.keys(out?.chapters ?? {})).toEqual(['2']);
        expect(Object.keys((await loadAnalysisCache(id)).chapters)).toEqual(['2']);
      });
    });

    it('remapCharacterIds rewrites cached sentence takes only; chapterCast and unmapped ids are left alone', async () => {
      await withCache(
        {
          version: 2,
          chapters: {
            1: [
              { id: 1, chapterId: 1, characterId: 'old', text: 't' },
              { id: 2, chapterId: 1, characterId: 'other', text: 'u' },
            ] as never,
          },
          chapterCast: { 1: [{ id: 'old', name: 'O', role: 'minor', color: 'halloran' }] as never },
        },
        async (id) => {
          await mutateAnalysisCache(id, { remapCharacterIds: { old: 'new' } });
          const c = await loadAnalysisCache(id);
          expect(c.chapters[1].map((s) => s.characterId)).toEqual(['new', 'other']);
          expect(c.chapterCast?.[1][0].id).toBe('old');
        },
      );
    });

    it('clearLedger with no sticky entries removes the addedRows key', async () => {
      await withCache(
        { version: 2, addedRows: { mine: { state: 'run-owned', fp: 'f' } } },
        async (id) => {
          const out = await mutateAnalysisCache(id, { clearLedger: true });
          expect(Object.hasOwn(out ?? {}, 'addedRows')).toBe(false);
          expect((await loadAnalysisCache(id)).addedRows).toBeUndefined();
        },
      );
    });

    describe('plan token handling', () => {
      const seeded = {
        version: 2,
        stage1,
        matchPlan: { version: 1 as const, runToken: 'T1', decisions: { a: dec('a', 'p1') } },
      };

      it('the same runToken keeps the stored decisions', async () => {
        await withCache(seeded, async (id) => {
          await mutateAnalysisCache(id, { matchPlan: { version: 1, runToken: 'T1' } });
          expect(Object.keys((await loadAnalysisCache(id)).matchPlan?.decisions ?? {})).toEqual([
            'a',
          ]);
        });
      });

      it('a different runToken empties the decisions', async () => {
        await withCache(seeded, async (id) => {
          await mutateAnalysisCache(id, { matchPlan: { version: 1, runToken: 'T2' } });
          const plan = (await loadAnalysisCache(id)).matchPlan;
          expect(plan?.runToken).toBe('T2');
          expect(plan?.decisions).toEqual({});
        });
      });

      it('decisions with no plan on disk rejects, leaves the file alone and does not poison the queue', async () => {
        await withCache({ version: 2, stage1 }, async (id) => {
          const before = readFileSync(cachePath(id));
          await expect(mutateAnalysisCache(id, { decisions: { a: dec('a', 'p1') } })).rejects.toThrow(
            'mutateAnalysisCache: decisions patched with no matchPlan',
          );
          expect(readFileSync(cachePath(id)).equals(before)).toBe(true);
          const out = await mutateAnalysisCache(id, { castDurations: { 1: 1 } });
          expect(out?.castDurations).toEqual({ 1: 1 });
          expect((await loadAnalysisCache(id)).castDurations).toEqual({ 1: 1 });
        });
      });
    });

    it('serialises against a concurrent save and does not deadlock', async () => {
      /* Not `withCache`: its cleanup awaits the very path chain a deadlock would wedge. */
      const id = fresh();
      await saveAnalysisCache(id, { chapters: {}, version: 2, stage1 });
      try {
        const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000));
        const work = Promise.all([
          saveAnalysisCache(id, { chapters: { 1: take }, version: 2, stage1 }),
          mutateAnalysisCache(id, { castDurations: { 1: 1 } }),
          saveAnalysisCache(id, { chapters: { 1: take, 2: take }, version: 2, stage1 }),
          mutateAnalysisCache(id, { castDurations: { 2: 2 } }),
        ]).then(() => 'done' as const);
        expect(await Promise.race([work, timeout])).toBe('done');
        const c = await loadAnalysisCache(id);
        /* Ops run in call order: the second save wrote no durations, then the last mutate adds one. */
        expect(c.castDurations).toEqual({ 2: 2 });
      } finally {
        rmSync(cachePath(id), { force: true });
      }
    });

    it('a mutate after clearAnalysisCache writes nothing; one with createIfAbsent writes a v2 cache', async () => {
      const id = fresh();
      try {
        await clearAnalysisCache(id);
        expect(await mutateAnalysisCache(id, { castDurations: { 1: 1 } })).toBeNull();
        expect(existsSync(cachePath(id))).toBe(false);
        const out = await mutateAnalysisCache(id, {
          castDurations: { 1: 1 },
          createIfAbsent: true,
        });
        expect(out?.version).toBe(2);
        expect((await loadAnalysisCache(id)).version).toBe(2);
        /* versionIfCreated applies only when the op creates the file (R9). */
        await mutateAnalysisCache(id, { versionIfCreated: 9 });
        expect((await loadAnalysisCache(id)).version).toBe(2);
      } finally {
        await clearAnalysisCache(id);
      }
    });
  });
});
