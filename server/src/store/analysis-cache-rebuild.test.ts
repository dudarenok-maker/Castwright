/* Unit tests for rebuildCacheFromEdits — plan 70c.

   The helper reads server/handoff/cache/{manuscriptId}.json via
   loadAnalysisCache / saveAnalysisCache, so the test points the cache
   resolution at a tempdir by spoofing the module's CACHE_DIR constant via
   the WORKSPACE_DIR env knob is NOT applicable (cache is resolved relative
   to the server source root, not workspace). Instead we use a unique
   manuscriptId per test and clean up after. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rebuildCacheFromEdits } from './analysis-cache-rebuild.js';
import {
  clearAnalysisCache,
  loadAnalysisCache,
  saveAnalysisCache,
} from './analysis-cache.js';

let tmp: string;
let editsPath: string;
let manuscriptId: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'audiobook-cache-rebuild-'));
  editsPath = join(tmp, 'manuscript-edits.json');
  manuscriptId = `m_rebuild_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(async () => {
  await clearAnalysisCache(manuscriptId);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('rebuildCacheFromEdits', () => {
  it('groups manuscript-edits.json sentences by chapterId and sorts by sentence id', async () => {
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 2, chapterId: 1, characterId: 'narr', text: 'A2' },
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A1' },
          { id: 1, chapterId: 2, characterId: 'sam', text: 'B1' },
        ],
      }),
    );

    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const cache = await loadAnalysisCache(manuscriptId);

    expect(Object.keys(cache.chapters).sort()).toEqual(['1', '2']);
    expect(cache.chapters[1].map((s) => s.id)).toEqual([1, 2]);
    expect(cache.chapters[1].map((s) => s.text)).toEqual(['A1', 'A2']);
    expect(cache.chapters[2][0].characterId).toBe('sam');
  });

  it('carries forward prior chapterCast / castDurations / stage1 / failedChapterIds', async () => {
    /* Seed a cache with metadata-only fields, then rebuild from edits.
       The metadata must persist so the analyzer's observed-rate samples
       and Phase 0 roster aren't lost on every restructure. */
    await saveAnalysisCache(manuscriptId, {
      chapters: {},
      chapterCast: { 1: [{ id: 'narr', name: 'Narrator', role: 'narrator', color: '#fff' }] },
      castDurations: { 1: 12345 },
      stage2Durations: { 1: 6789 },
      failedChapterIds: [2],
      stage1: {
        characters: [{ id: 'narr', name: 'Narrator', role: 'narrator', color: '#fff' }],
        chapters: [{ id: 1, title: 'One' }],
      },
    });
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'x' }],
      }),
    );

    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const cache = await loadAnalysisCache(manuscriptId);

    expect(cache.chapterCast).toBeDefined();
    expect(cache.castDurations).toEqual({ 1: 12345 });
    expect(cache.stage2Durations).toEqual({ 1: 6789 });
    expect(cache.failedChapterIds).toEqual([2]);
    expect(cache.stage1?.characters[0].id).toBe('narr');
    expect(cache.chapters[1]).toHaveLength(1);
  });

  it('clears the cache when manuscript-edits.json has zero sentences', async () => {
    /* Seed a cache, then rebuild from an empty edits file — there is
       nothing to populate from, so dropping the cache is the right
       answer rather than serving stale chapters. */
    await saveAnalysisCache(manuscriptId, {
      chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'stale' }] },
    });
    writeFileSync(editsPath, JSON.stringify({ sentences: [] }));

    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const cache = await loadAnalysisCache(manuscriptId);
    expect(cache.chapters).toEqual({});
  });

  it('clears the cache when manuscript-edits.json is missing', async () => {
    await saveAnalysisCache(manuscriptId, {
      chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'stale' }] },
    });
    /* editsPath never written — readJson returns null and the helper
       treats that as an empty sentence list. */
    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const cache = await loadAnalysisCache(manuscriptId);
    expect(cache.chapters).toEqual({});
  });

  it('is idempotent — calling twice produces the same cache contents', async () => {
    writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'A1' },
          { id: 2, chapterId: 1, characterId: 'narr', text: 'A2' },
        ],
      }),
    );

    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const first = await loadAnalysisCache(manuscriptId);
    await rebuildCacheFromEdits(manuscriptId, editsPath);
    const second = await loadAnalysisCache(manuscriptId);

    expect(second.chapters).toEqual(first.chapters);
  });
});
