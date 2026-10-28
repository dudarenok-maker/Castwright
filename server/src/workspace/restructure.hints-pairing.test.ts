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
  chapters: Array<{ id: number; title: string; titleOverridden?: boolean; titleSynthesized?: boolean }>,
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

  it('a null parse title is not a mismatch by itself, but the state title there must not be a heading from another position', () => {
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

describe('a heading moved onto a parser-made (null) position is caught', () => {
  /* Reorder renumbers an app-made title, so a swap between an app-titled chapter and a
     heading chapter leaves a null parse title at one position (now holding the heading's
     state title) and an app-made, synthesized title where the heading was. The heading at
     the null position is the evidence; the synthesized `Chapter 2` is drift and pairs. */
  const swapped = stateOf([
    { id: 1, title: 'Chapter Two' },
    { id: 2, title: 'Chapter 2', titleSynthesized: true },
    { id: 3, title: 'Chapter Three' },
  ]);

  it('flags the swap', () => {
    expect(parseTitlesPairWithState(swapped, [null, 'Chapter Two', 'Chapter Three'])).toBe(false);
  });

  it('still passes a book whose app-made titles sit where the parse made them up', () => {
    const healthy = stateOf([
      { id: 1, title: 'Chapter 1', titleSynthesized: true },
      { id: 2, title: 'Chapter Two' },
    ]);
    expect(parseTitlesPairWithState(healthy, [null, 'Chapter Two'])).toBe(true);
  });
});

describe('title drift is not a mispairing (#3829)', () => {
  /* Parser changes (entity decoding, heading normalisation) alter a title after state.json
     was written. A drifted title matches no OTHER position's parse title; a pre-#3703 reorder
     puts a heading at another position. */
  it('pairs a position whose state title is an older parser form of its own heading', () => {
    const s = stateOf([
      { id: 1, title: 'Alpha' },
      { id: 2, title: 'The Wizard&rsquo;s Tower' },
    ]);
    expect(parseTitlesPairWithState(s, ['Alpha', 'The Wizard’s Tower'])).toBe(true);
  });

  it('mispairs headings reordered among themselves', () => {
    const s = stateOf([
      { id: 1, title: 'Gamma' },
      { id: 2, title: 'Alpha' },
      { id: 3, title: 'Beta' },
    ]);
    expect(parseTitlesPairWithState(s, ['Alpha', 'Beta', 'Gamma'])).toBe(false);
  });

  it('pairs drift next to a titleOverridden chapter', () => {
    const s = stateOf([
      { id: 1, title: 'Alpha' },
      { id: 2, title: 'Mine', titleOverridden: true },
      { id: 3, title: 'Caf&eacute;' },
    ]);
    expect(parseTitlesPairWithState(s, ['Alpha', 'Beta', 'Café'])).toBe(true);
  });

  it('still mispairs a reorder when another position has also drifted', () => {
    const s = stateOf([
      { id: 1, title: 'Beta' },
      { id: 2, title: 'Alpha' },
      { id: 3, title: 'Caf&eacute;' },
    ]);
    expect(parseTitlesPairWithState(s, ['Alpha', 'Beta', 'Café'])).toBe(false);
  });
});

describe('an app-made title at a null position (#3829)', () => {
  /* An untitled lead section followed by a bare "Chapter 1" heading: the parser's fallback
     title for position 0 ("Chapter 1") repeats the real heading at position 1. A fresh import
     has every title at home, so it pairs; a heading that left home for position 0 does not. */
  const parse = [null, 'Chapter 1', 'Chapter 2'];

  it('pairs a synthesized state title that repeats a real heading elsewhere', () => {
    const s = stateOf([
      { id: 1, title: 'Chapter 1', titleSynthesized: true },
      { id: 2, title: 'Chapter 1' },
      { id: 3, title: 'Chapter 2' },
    ]);
    expect(parseTitlesPairWithState(s, parse)).toBe(true);
  });

  it('pairs the pre-#3628 unflagged variant', () => {
    const s = stateOf([
      { id: 1, title: 'Chapter 1' },
      { id: 2, title: 'Chapter 1' },
      { id: 3, title: 'Chapter 2' },
    ]);
    expect(parseTitlesPairWithState(s, parse)).toBe(true);
  });

  it('mispairs a "Chapter 1" heading moved onto the null position, flagged or not', () => {
    for (const flag of [{ titleSynthesized: true }, {}]) {
      const s = stateOf([
        { id: 1, title: 'Chapter 1' },
        { id: 2, title: 'Chapter 2', ...flag },
        { id: 3, title: 'The Storm' },
      ]);
      expect(parseTitlesPairWithState(s, [null, 'Chapter 1', 'The Storm'])).toBe(false);
    }
  });
});

describe('drift into a repeated heading (#3829)', () => {
  /* Imported before the parser started merging a non-ASCII subtitle: state is
     [Chapter 1, Chapter 2, Chapter 1], today's parse [Chapter 1, Chapter 2, Chapter 1 - Elan].
     Position 2 matches position 0's heading, but that heading is still at home. */
  it('pairs', () => {
    const s = stateOf([
      { id: 1, title: 'Chapter 1' },
      { id: 2, title: 'Chapter 2' },
      { id: 3, title: 'Chapter 1' },
    ]);
    expect(parseTitlesPairWithState(s, ['Chapter 1', 'Chapter 2', 'Chapter 1 \u2014 \u00c9lan'])).toBe(true);
  });
});

describe('documented blind spot: a same-count merge then split (#3829)', () => {
  /* The UI's split titles the second half "<title> (cont.)", a title no parse contains, so a
     pre-#3703 merge + split moves a break without moving a heading. A title-only rule cannot tell
     it from drift. Pinned as PAIRS so a future fix (body evidence) flips this deliberately. */
  it('pairs', () => {
    const s = stateOf([
      { id: 1, title: 'Alpha' },
      { id: 2, title: 'Beta' },
      { id: 3, title: 'Gamma' },
      { id: 4, title: 'Gamma (cont.)' },
    ]);
    expect(parseTitlesPairWithState(s, ['Alpha', 'Beta', 'Gamma', 'Delta'])).toBe(true);
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
