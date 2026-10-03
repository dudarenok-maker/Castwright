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
