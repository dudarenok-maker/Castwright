/* assertHintsPairWithState (#3791): the count + id check for every hint source,
 * plus the position-by-position title check for hints from a parse fallback.
 * The shipped samples are the "never refuse a freshly imported book" control:
 * their state.json titles are the parser's own, so they must pair. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHintsPairWithState,
  parseTitlesPairWithState,
  HintsOutOfSyncError,
} from './restructure.js';
import { parseManuscript } from '../parsers/index.js';
import type { BookStateJson } from './scan.js';
import type { ChapterHint } from '../store/manuscripts.js';

function stateOf(
  chapters: Array<{ id: number; title: string; titleOverridden?: boolean }>,
): BookStateJson {
  return { chapters: chapters.map((c) => ({ ...c, slug: `s${c.id}` })) } as unknown as BookStateJson;
}
const hintsOf = (ids: number[]): ChapterHint[] => ids.map((id) => ({ id, title: `T${id}`, body: 'x' }));

describe('assertHintsPairWithState', () => {
  const state = stateOf([
    { id: 1, title: 'Beta' },
    { id: 2, title: 'Alpha' },
  ]);

  it('throws on a count mismatch', () => {
    expect(() => assertHintsPairWithState(state, hintsOf([1]))).toThrow(HintsOutOfSyncError);
  });

  it('throws on an id the state lacks', () => {
    expect(() => assertHintsPairWithState(state, hintsOf([1, 3]))).toThrow(HintsOutOfSyncError);
  });

  it('does not title-check without parse titles (persisted hints)', () => {
    expect(() => assertHintsPairWithState(state, hintsOf([1, 2]))).not.toThrow();
  });

  it('throws when parse titles disagree with state at a position', () => {
    expect(() => assertHintsPairWithState(state, hintsOf([1, 2]), ['Alpha', 'Beta'])).toThrow(
      HintsOutOfSyncError,
    );
  });

  it('passes when parse titles equal state titles', () => {
    expect(() => assertHintsPairWithState(state, hintsOf([1, 2]), ['Beta', 'Alpha'])).not.toThrow();
  });

  it('skips a position the parser made up (null), which says nothing about identity', () => {
    expect(parseTitlesPairWithState(state, [null, 'Alpha'])).toBe(true);
    expect(parseTitlesPairWithState(state, [null, 'Beta'])).toBe(false);
  });

  it('skips a titleOverridden chapter (the user own wording)', () => {
    const s = stateOf([
      { id: 1, title: 'Mine', titleOverridden: true },
      { id: 2, title: 'Alpha' },
    ]);
    expect(parseTitlesPairWithState(s, ['Beta', 'Alpha'])).toBe(true);
  });
});

describe('every shipped sample pairs with its state under the title check', () => {
  const samplesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'samples');
  const names = readdirSync(samplesRoot);

  it('finds the samples', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(name, async () => {
      const dir = join(samplesRoot, name);
      const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8')) as BookStateJson;
      const parsed = await parseManuscript({
        buffer: readFileSync(join(dir, state.manuscriptFile)),
        fileName: state.manuscriptFile,
      });
      expect(() =>
        assertHintsPairWithState(
          state,
          parsed.chapters,
          parsed.chapters.map((c) => (c.titleSynthesized ? null : c.title)),
        ),
      ).not.toThrow();
    });
  }
});
