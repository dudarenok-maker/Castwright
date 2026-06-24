/* srv-50 — unit coverage for the shared post-fold sentence loader hoisted out
   of annotate-emotion.ts + script-review.ts. The originals were only covered
   indirectly through their route integration tests; this locks the
   reconciliation branches directly so the two routes can't drift on it.

   The reconciliation rule (mirrors book-state.ts): when BOTH a folded
   manuscript-edits.json and an analysis cache exist, keep an edit sentence iff
   its id still appears in the cache OR exceeds the cache's max id (a
   user-created split offspring whose id was minted after analysis). */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentenceOutput } from '../handoff/schemas.js';
import { saveAnalysisCache, clearAnalysisCache } from './analysis-cache.js';
import { loadPostFoldSentencesByChapter } from './post-fold-sentences.js';

/* Minimal SentenceOutput — the loader only reads `id` and `chapterId`, but we
   carry text/characterId so the assertions read like real sentences. */
function sent(id: number, chapterId: number, text = `s${id}`): SentenceOutput {
  return { id, chapterId, characterId: 'narrator', text } as SentenceOutput;
}

let bookDir: string;
let manuscriptId: string;
let seq = 0;

function newBook(): void {
  bookDir = mkdtempSync(join(tmpdir(), 'audiobook-postfold-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  manuscriptId = `m_postfold_${process.pid}_${seq++}`;
}

function writeEdits(sentences: unknown[]): void {
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
}

afterEach(async () => {
  if (manuscriptId) await clearAnalysisCache(manuscriptId);
  if (bookDir) rmSync(bookDir, { recursive: true, force: true });
});

describe('loadPostFoldSentencesByChapter', () => {
  it('falls back to the analysis cache when no edits file exists', async () => {
    newBook();
    await saveAnalysisCache(manuscriptId, {
      chapters: { 1: [sent(1, 1), sent(2, 1)], 2: [sent(3, 2)] },
    });

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect([...byChapter.keys()].sort()).toEqual([1, 2]);
    expect(byChapter.get(1)!.map((s) => s.id)).toEqual([1, 2]);
    expect(byChapter.get(2)!.map((s) => s.id)).toEqual([3]);
  });

  it('uses the edits list wholesale when no cache exists', async () => {
    newBook();
    writeEdits([sent(10, 1), sent(11, 2)]);

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect(byChapter.get(1)!.map((s) => s.id)).toEqual([10]);
    expect(byChapter.get(2)!.map((s) => s.id)).toEqual([11]);
  });

  it('reconciles edits against the cache: keeps ids still in cache, drops stale ids', async () => {
    newBook();
    // maxCacheId = 50, so a stale id must be ≤ 50 to be dropped (above it = split offspring).
    await saveAnalysisCache(manuscriptId, { chapters: { 1: [sent(1, 1), sent(2, 1), sent(50, 1)] } });
    // id 1 survives (in cache); id 30 is stale (not in cache, ≤ maxCacheId) → dropped.
    writeEdits([sent(1, 1, 'edited'), sent(30, 1)]);

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    const ch1 = byChapter.get(1)!;
    expect(ch1.map((s) => s.id)).toEqual([1]);
    expect(ch1[0].text).toBe('edited'); // the edited copy wins, not the cache copy
  });

  it('keeps a split offspring whose id exceeds the cache max id', async () => {
    newBook();
    await saveAnalysisCache(manuscriptId, { chapters: { 1: [sent(1, 1), sent(2, 1)] } });
    // id 1000 isn't in the cache but is > maxCacheId (2) → a user-created split offspring, kept.
    writeEdits([sent(1, 1), sent(1000, 1)]);

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect(byChapter.get(1)!.map((s) => s.id)).toEqual([1, 1000]);
  });

  it('passes through an edit sentence with a non-numeric id during reconciliation', async () => {
    newBook();
    await saveAnalysisCache(manuscriptId, { chapters: { 1: [sent(1, 1)] } });
    writeEdits([{ id: 'oops', chapterId: 1, characterId: 'narrator', text: 'malformed' }]);

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect(byChapter.get(1)!.map((s) => s.text)).toEqual(['malformed']);
  });

  it('skips sentences with a non-numeric chapterId when grouping', async () => {
    newBook();
    writeEdits([
      sent(1, 1),
      { id: 2, chapterId: 'nope', characterId: 'narrator', text: 'orphan' },
      sent(3, 1),
    ]);

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect([...byChapter.keys()]).toEqual([1]);
    expect(byChapter.get(1)!.map((s) => s.id)).toEqual([1, 3]);
  });

  it('returns an empty map when neither cache nor edits exist', async () => {
    newBook();

    const byChapter = await loadPostFoldSentencesByChapter(manuscriptId, bookDir);

    expect(byChapter.size).toBe(0);
  });
});
