/* Unit tests for the cast-merge-suggestions sibling-file store. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
});
