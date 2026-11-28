/* Unit tests for the cast-merge-suggestions sibling-file store. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredSuggestion } from './reanalysis-types.js';

/** A dedup-origin stored suggestion, pair key derived the way the store does. */
function stored(
  sourceId: string,
  targetId: string,
  reason = `diminutive of ${targetId}`,
  extra: Partial<StoredSuggestion> = {},
): StoredSuggestion {
  const [a, b] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
  return { sourceId, targetId, a, b, reason, origin: 'dedup', ...extra };
}

const never = () => false;

describe('cast-merge-suggestions store', () => {
  let workspaceRoot: string;
  let bookDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merge-suggestions-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    bookDir = join(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  });

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('load on missing file returns { suggestions: [] }', async () => {
    const { loadSuggestions } = await import('./cast-merge-suggestions.js');
    const result = await loadSuggestions(bookDir);
    expect(result).toEqual({ suggestions: [] });
  });

  it('stores one entry per unordered pair and keeps its direction', async () => {
    const { reconcileSuggestionsLocked, loadStoredSuggestions, pairKey } = await import(
      './cast-merge-suggestions.js'
    );
    expect(pairKey('olya', 'olga')).toEqual({ a: 'olga', b: 'olya' });
    expect(pairKey('olga', 'olya')).toEqual({ a: 'olga', b: 'olya' });

    await reconcileSuggestionsLocked(bookDir, {
      add: [stored('olya', 'olga'), stored('olga', 'olya')],
      liveIds: new Set(['olya', 'olga']),
      supersededBy: {},
      declined: never,
    });
    // a later run offering the same pair the other way round does not flip it
    await reconcileSuggestionsLocked(bookDir, {
      add: [stored('olga', 'olya', 'a later reason')],
      liveIds: new Set(['olya', 'olga']),
      supersededBy: {},
      declined: never,
    });

    const result = await loadStoredSuggestions(bookDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sourceId: 'olya', targetId: 'olga', a: 'olga', b: 'olya' });
  });

  it('a legacy entry loads with no newRow', async () => {
    const { loadStoredSuggestions, loadSuggestions } = await import('./cast-merge-suggestions.js');
    const { castMergeSuggestionsJsonPath } = await import('../workspace/paths.js');
    writeFileSync(
      castMergeSuggestionsJsonPath(bookDir),
      JSON.stringify({
        suggestions: [{ sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' }],
      }),
    );
    const result = await loadStoredSuggestions(bookDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceId: 'оля',
      targetId: 'ольга',
      reason: 'Diminutive of «Ольга»',
      origin: 'dedup',
      a: 'ольга',
      b: 'оля',
    });
    expect('newRow' in result[0]).toBe(false);
    expect(await loadSuggestions(bookDir)).toEqual({
      suggestions: [{ sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' }],
    });
  });

  it('reconcile keeps an open suggestion and drops one once a row is gone, merged or declined', async () => {
    const { reconcileSuggestionsLocked, loadStoredSuggestions } = await import(
      './cast-merge-suggestions.js'
    );
    const all = ['o1', 'o2', 'g1', 'g2', 'm1', 'm2', 'd1', 'd2', 'k1', 'k2'];
    await reconcileSuggestionsLocked(bookDir, {
      add: [
        stored('k1', 'k2'), // stays open
        stored('o1', 'o2'), // o2 will vanish
        stored('m1', 'm2'), // m1 was merged into m2
        stored('d1', 'd2'), // declined
      ],
      liveIds: new Set(all),
      supersededBy: {},
      declined: never,
    });
    expect(await loadStoredSuggestions(bookDir)).toHaveLength(4);

    // a second reconcile adds nothing: the open one is kept, the rest resolve
    await reconcileSuggestionsLocked(bookDir, {
      add: [],
      liveIds: new Set(all.filter((id) => id !== 'o2')),
      supersededBy: { m1: 'm2' },
      declined: (x, y) => x === 'd1' && y === 'd2',
    });
    const kept = await loadStoredSuggestions(bookDir);
    expect(kept.map((s) => s.sourceId)).toEqual(['k1']);
  });

  it('reconcile removes the pairs it is told to, whichever way round', async () => {
    const { reconcileSuggestionsLocked, removeSuggestionPairsLocked, loadStoredSuggestions } =
      await import('./cast-merge-suggestions.js');
    await reconcileSuggestionsLocked(bookDir, {
      add: [stored('ваня', 'иван'), stored('оля', 'ольга'), stored('саша', 'александр')],
      liveIds: new Set(['ваня', 'иван', 'оля', 'ольга', 'саша', 'александр']),
      supersededBy: {},
      declined: never,
    });
    await removeSuggestionPairsLocked(bookDir, [['иван', 'ваня']]);
    const result = await loadStoredSuggestions(bookDir);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.sourceId === 'ваня')).toBeUndefined();
    expect(result.find((s) => s.sourceId === 'оля')).toBeDefined();
    expect(result.find((s) => s.sourceId === 'саша')).toBeDefined();

    await removeSuggestionPairsLocked(bookDir, [['nonexistent', 'target']]);
    expect(await loadStoredSuggestions(bookDir)).toHaveLength(2);
  });

  /* #4101 — a plan-origin dismissal takes back the declines the new row inherited
     from the candidate the user has just called a different person. */
  describe('dismissSuggestionDurably drops inherited cross-book declines', () => {
    const BOOK = 'this-book';
    const x = { bookId: 'other-book-1', characterId: 'wren' };
    // y shares x's character id and z shares x's book id: an entry matches on both.
    const y = { bookId: 'other-book-2', characterId: 'wren' };
    const z = { bookId: 'other-book-1', characterId: 'sparrow' };
    const newEdge = { bookId: BOOK, characterId: 'cand' };
    const candEdge = { bookId: BOOK, characterId: 'fresh' };

    type Row = { id: string; notLinkedTo?: unknown[] };

    async function dismiss(opts: {
      newDeclines: unknown[];
      candDeclines: unknown[];
      suggestion: Partial<StoredSuggestion>;
    }): Promise<{ newRow: Row; candRow: Row }> {
      const { dismissSuggestionDurably } = await import('./cast-merge-suggestions.js');
      const { castJsonPath, castMergeSuggestionsJsonPath } = await import('../workspace/paths.js');
      writeFileSync(
        castJsonPath(bookDir),
        JSON.stringify({
          characters: [
            { id: 'fresh', notLinkedTo: opts.newDeclines },
            { id: 'cand', notLinkedTo: opts.candDeclines },
          ],
        }),
      );
      writeFileSync(
        castMergeSuggestionsJsonPath(bookDir),
        JSON.stringify({
          suggestions: [
            stored('fresh', 'cand', 'same person?', opts.suggestion),
            stored('k1', 'k2'),
          ],
        }),
      );
      // the other way round from how it is stored: the pair is unordered
      await dismissSuggestionDurably(bookDir, BOOK, 'cand', 'fresh', () => {});
      const rows = (JSON.parse(readFileSync(castJsonPath(bookDir), 'utf8')) as { characters: Row[] })
        .characters;
      return { newRow: rows[0], candRow: rows[1] };
    }

    const planSuggestion: Partial<StoredSuggestion> = {
      origin: 'plan',
      newRow: 'fresh',
      candidate: 'cand',
    };

    it('plan origin: removes from newRow only the cross-book entries the candidate also holds', async () => {
      const { newRow, candRow } = await dismiss({
        newDeclines: [x, y, z],
        candDeclines: [x],
        suggestion: planSuggestion,
      });
      expect(newRow.notLinkedTo).not.toContainEqual(x);
      expect(newRow.notLinkedTo).toContainEqual(y);
      expect(newRow.notLinkedTo).toEqual([y, z, newEdge]);
      expect(candRow.notLinkedTo).toEqual([x, candEdge]);
    });

    it('plan origin: still writes the dismissal record and removes only that pair', async () => {
      await dismiss({ newDeclines: [x], candDeclines: [x], suggestion: planSuggestion });
      const { loadCastIdHistoryWithStatus } = await import('./cast-id-history.js');
      const { loadStoredSuggestions } = await import('./cast-merge-suggestions.js');
      const { history } = await loadCastIdHistoryWithStatus(bookDir);
      expect(history.notSamePerson).toEqual([expect.objectContaining({ a: 'cand', b: 'fresh' })]);
      expect((await loadStoredSuggestions(bookDir)).map((s) => s.sourceId)).toEqual(['k1']);
    });

    it('plan origin: writes the removal even when both dismissal edges already exist', async () => {
      const { newRow, candRow } = await dismiss({
        newDeclines: [x, newEdge],
        candDeclines: [x, candEdge],
        suggestion: planSuggestion,
      });
      expect(newRow.notLinkedTo).toEqual([newEdge]);
      expect(candRow.notLinkedTo).toEqual([x, candEdge]);
    });

    it('plan origin: keeps same-book and bare-string entries the candidate also holds', async () => {
      // newEdge is the very edge a dismissal writes: shared, and still kept
      const shared = [newEdge, { bookId: BOOK, characterId: 'third' }, 'legacy-id'];
      const { newRow } = await dismiss({
        newDeclines: [...shared, x],
        candDeclines: [...shared, x],
        suggestion: planSuggestion,
      });
      expect(newRow.notLinkedTo).toEqual(shared);
    });

    it.each<[string, Partial<StoredSuggestion>]>([
      ['a dedup-origin suggestion', { origin: 'dedup', newRow: 'fresh', candidate: 'cand' }],
      ['a plan suggestion with no candidate', { origin: 'plan', newRow: 'fresh' }],
      ['a plan suggestion with no newRow', { origin: 'plan', candidate: 'cand' }],
    ])('%s removes nothing', async (_label, suggestion) => {
      const { newRow, candRow } = await dismiss({
        newDeclines: [x, y],
        candDeclines: [x],
        suggestion,
      });
      expect(newRow.notLinkedTo).toEqual([x, y, newEdge]);
      expect(candRow.notLinkedTo).toEqual([x, candEdge]);
    });
  });
});
