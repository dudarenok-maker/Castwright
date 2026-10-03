import { describe, it, expect } from 'vitest';
import {
  cachePath,
  clearAnalysisCache,
  loadAnalysisCache,
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

describe('hasCurrentTake (plan 285 spec 2.2)', () => {
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

describe('analysisCompleteFor (plan 285 spec 2.2)', () => {
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

describe('reachedConfirm (plan 285 decision F)', () => {
  it('reads castConfirmed or confirmReached', async () => {
    const { reachedConfirm } = await import('./analysis-cache.js');
    expect(reachedConfirm({ castConfirmed: true }, { chapters: {} })).toBe(true);
    expect(reachedConfirm({ castConfirmed: false }, { chapters: {}, confirmReached: true })).toBe(true);
    expect(reachedConfirm({}, { chapters: {} })).toBe(false);
    expect(reachedConfirm(undefined, { chapters: {} })).toBe(false);
  });
});

describe('loadAnalysisCache keeps the plan-285 completeness fields', () => {
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
