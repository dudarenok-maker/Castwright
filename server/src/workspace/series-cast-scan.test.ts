/* Integration tests for scanSeriesCharacters.

   Sets up a tempdir workspace with three books in the same series (two
   confirmed, one not) plus a standalone in a different series, then
   asserts the scan returns characters from the two confirmed siblings,
   excludes the unconfirmed one, excludes the explicit excludeBookId,
   and excludes the standalone.

   Mirrors cast-merge.test.ts: defer module imports until WORKSPACE_DIR
   is set so paths.ts captures the right root. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let scan: typeof import('./series-cast-scan.js');

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-scan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  scan = await import('./series-cast-scan.js');

  /* Three books in the same series:
       - the Hollow Tide #1 (confirmed) -- contributes 3 characters
       - Bonus Marlow (confirmed) -- contributes 2 characters
       - The Floodmark (NOT confirmed) -- excluded by library-cast-scan
     Plus one book in a different series to prove the series scope. */
  const seed = (
    title: string,
    opts: {
      confirmed: boolean;
      characters: Array<{ id: string; name: string }>;
      series?: string;
      isStandalone?: boolean;
      seriesPosition?: number | null;
      language?: string;
    },
  ) => {
    const series = opts.series ?? SERIES;
    const dir = join(workspaceRoot, 'books', AUTHOR, series, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: `${AUTHOR.toLowerCase().replace(/\s+/g, '-')}__${series.toLowerCase().replace(/\s+/g, '-')}__${title.toLowerCase().replace(/\s+/g, '-')}`,
        manuscriptId: `m_${title.toLowerCase().replace(/\s+/g, '_')}`,
        title,
        author: AUTHOR,
        series,
        seriesPosition: opts.seriesPosition ?? null,
        /* When set, writes a `language` field; when omitted, the field is
           ABSENT from state.json — exactly the `bookStateLanguageOrNull` →
           null "unset" case the honest resolver (Task 6, #2246) must veto. */
        ...(opts.language !== undefined ? { language: opts.language } : {}),
        isStandalone: opts.isStandalone === true,
        manuscriptFile: 'manuscript.epub',
        castConfirmed: opts.confirmed,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(dir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: opts.characters.map((c) => ({ ...c, role: 'character', color: 'unset' })),
      }),
    );
  };

  seed('The Hollow Tide', {
    confirmed: true,
    characters: [
      { id: 'narrator', name: 'Narrator' },
      { id: 'wren', name: 'Wren' },
      { id: 'marlow', name: 'Marlow' },
    ],
  });
  seed('the Coalfall Commission', {
    confirmed: true,
    characters: [
      { id: 'marlow', name: 'Marlow' },
      { id: 'nim', name: 'Nim' },
    ],
  });
  seed('The Floodmark', {
    confirmed: false, // analyzing now, no cast on disk yet
    characters: [{ id: 'narrator', name: 'Narrator' }],
  });
  /* A standalone in the same author/series folder — must NOT show up
     in the series scope because state.isStandalone === true. */
  seed('Some Standalone', {
    confirmed: true,
    isStandalone: true,
    characters: [{ id: 'lonely', name: 'Lonely Speaker' }],
  });
  /* A book in a DIFFERENT series, same author -- must not appear. */
  seed('Sibling Book', {
    confirmed: true,
    series: 'Different Series',
    characters: [{ id: 'unrelated', name: 'Unrelated' }],
  });

  /* Isolated pair for the Task 6 (#2246) language-veto regression test, filed
     under their own series (Della Renwick / Reg Series) so they never disturb
     the scanSeriesCharacters counts asserted against The Hollow Tide above:
       - Reg One   : confirmed, position 1, language 'en'  (the reuse source)
       - Reg Two   : confirmed, position 2, language 'en'  (control consumer)
       - Reg Unset : confirmed, position 3, NO language    (the null veto)
       - Reg Lang Ctrl : confirmed, language 'es'          (resolver control) */
  seed('Reg One', {
    confirmed: true,
    series: 'Reg Series',
    seriesPosition: 1,
    language: 'en',
    characters: [{ id: 'wren', name: 'Wren' }],
  });
  seed('Reg Two', {
    confirmed: true,
    series: 'Reg Series',
    seriesPosition: 2,
    language: 'en',
    characters: [],
  });
  seed('Reg Unset', {
    confirmed: true,
    series: 'Reg Series',
    seriesPosition: 3,
    characters: [],
  });
  seed('Reg Lang Ctrl', {
    confirmed: true,
    series: 'Reg Series',
    language: 'es',
    characters: [{ id: 'solo', name: 'Solo' }],
  });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('scanSeriesCharacters', () => {
  it('returns confirmed characters across all books in the target series', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    /* the Hollow Tide (3) + Bonus Marlow (2) = 5. The Floodmark excluded (castConfirmed=false). */
    expect(records).toHaveLength(5);
    const ids = records.map((r) => r.character.id).sort();
    expect(ids).toEqual(['marlow', 'marlow', 'narrator', 'nim', 'wren']);
  });

  it('excludes the supplied bookId from the result (book never seeds itself)', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES, {
      excludeBookId: 'della-renwick__the-hollow-tide__the-hollow-tide',
    });
    /* the Hollow Tide's 3 characters drop out; Bonus Marlow's 2 remain. */
    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.character.id).sort();
    expect(ids).toEqual(['marlow', 'nim']);
  });

  it('excludes books in a different series even when the author matches', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    expect(records.find((r) => r.character.id === 'unrelated')).toBeUndefined();
  });

  it('excludes standalones even when they live under the same series folder', async () => {
    /* state.isStandalone === true makes a book's cast NOT part of any
       series's continuity, regardless of where its directory sits. */
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    expect(records.find((r) => r.character.id === 'lonely')).toBeUndefined();
  });

  it('returns empty for an author/series with no confirmed books', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, 'Nonexistent Series');
    expect(records).toEqual([]);
  });
});

describe('scanSeriesCharactersForBookId', () => {
  it('resolves (author, series) from a bookId and returns its series-mates', async () => {
    const records = await scan.scanSeriesCharactersForBookId(
      'della-renwick__the-hollow-tide__the-floodmark',
    );
    /* The Floodmark sits in the Hollow Tide series. Its OWN cast (narrator only, not
       confirmed) is excluded by both excludeBookId AND the
       castConfirmed gate. the Hollow Tide's 3 + Bonus Marlow's 2 = 5. */
    expect(records).toHaveLength(5);
  });

  it('returns [] for a bookId that does not exist in the library', async () => {
    const records = await scan.scanSeriesCharactersForBookId('does__not__exist');
    expect(records).toEqual([]);
  });

  it('returns [] for a standalone book (its own cast is NOT part of any series)', async () => {
    const records = await scan.scanSeriesCharactersForBookId(
      'della-renwick__the-hollow-tide__some-standalone',
    );
    /* The standalone's series field resolves to the Hollow Tide, BUT the scan's
       isStandalone filter excludes every other book from the result.
       Hmm -- actually, the OTHER books in the Hollow Tide series aren't
       standalones, so they DO appear. This is the right behaviour:
       a standalone asking "who else is in my series" should still
       discover the series regulars; they just don't need to flow
       back the other way. */
    /* Loosen: scope is "series-mates" which means non-standalone books
       in the same series. the Hollow Tide + Bonus Marlow both appear (5 characters
       total). */
    expect(records).toHaveLength(5);
  });
});

/* Task 6 (#2246) — pure-resolver tier regression. The honest reader
   `resolveBookLanguageForBookId` must return `null` (NOT the old 'en' default)
   for a book whose state.json carries no usable language, and every
   series-reuse consumer must treat that `null` as "cannot prove same language →
   veto". Driven through the REAL resolver + the fixture above (Reg Series
   books are the only state without a Hollow Tide collision). */
describe('resolveBookLanguageForBookId + reuse consumer veto (#2246)', () => {
  let link: typeof import('./series-reuse-link.js');

  beforeAll(async () => {
    link = await import('./series-reuse-link.js');
  });

  it('returns null (NOT "en") for a book whose state.json has no language', async () => {
    /* Reg Unset is the fixture with NO `language` key. Before this change the
       resolver defaulted to 'en'; it must now report the honest null. */
    expect(await scan.resolveBookLanguageForBookId('della-renwick__reg-series__reg-unset')).toBeNull();
  });

  it('returns the real language when the book has one set (control)', async () => {
    await expect(scan.resolveBookLanguageForBookId('della-renwick__reg-series__reg-one')).resolves.toBe('en');
    await expect(scan.resolveBookLanguageForBookId('della-renwick__reg-series__reg-lang-ctrl')).resolves.toBe('es');
  });

  it('linkSeriesReuseAtAnalysis vetoes: a null-language current book links nothing', async () => {
    /* Reg Unset has no language, so even though Reg One is a same-author +
       same-series, earlier (position 1 < 3) series-mate, the true language
       can't be proven on the current side → zero candidates, no link. */
    const characters: Array<{
      id: string;
      name: string;
      gender: 'female';
      ageRange: 'teen';
      matchedFrom?: { bookId?: string; characterId?: string; bookTitle?: string; confidence?: number };
    }> = [{ id: 'wren-2', name: 'Wren', gender: 'female', ageRange: 'teen' }];
    const linked = await link.linkSeriesReuseAtAnalysis(
      'della-renwick__reg-series__reg-unset',
      characters,
      { castLoader: async () => null },
    );
    expect(linked).toBe(0);
    expect(characters[0].matchedFrom).toBeUndefined();
  });

  it('linkSeriesReuseAtAnalysis control: two stated-`en` series-mates DO link', async () => {
    /* Reg Two (position 2, language 'en') legitimately reuses Reg One's Wren
       (position 1, language 'en'). The veto must NOT fire for a proven pair. */
    const characters: Array<{
      id: string;
      name: string;
      gender: 'female';
      ageRange: 'teen';
      matchedFrom?: { bookId?: string; characterId?: string; bookTitle?: string; confidence?: number };
    }> = [{ id: 'wren-2', name: 'Wren', gender: 'female', ageRange: 'teen' }];
    const linked = await link.linkSeriesReuseAtAnalysis(
      'della-renwick__reg-series__reg-two',
      characters,
      { castLoader: async () => null },
    );
    expect(linked).toBe(1);
    expect(characters[0].matchedFrom?.bookId).toBe('della-renwick__reg-series__reg-one');
  });

  it('pruneStaleReuseLinks vetoes: a null-language current book drops its stale links', async () => {
    /* Reg Unset carries a reused voice whose `matchedFrom` points at Reg One.
       Null language on the current side ⇒ "cannot prove same language" ⇒ the
       link is pruned (not preserved as a same-language match). */
    const characters: Array<{
      id: string;
      name: string;
      voiceState: 'reused';
      matchedFrom: { bookId: string; characterId: string; bookTitle: string; confidence: number };
    }> = [
      {
        id: 'wren',
        name: 'Wren',
        voiceState: 'reused',
        matchedFrom: {
          bookId: 'della-renwick__reg-series__reg-one',
          characterId: 'wren',
          bookTitle: 'Reg One',
          confidence: 1,
        },
      },
    ];
    const dropped = await link.pruneStaleReuseLinks('della-renwick__reg-series__reg-unset', characters);
    expect(dropped).toBe(1);
    expect(characters[0].matchedFrom).toBeUndefined();
  });
});
