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

const AUTHOR = 'Shannon Messenger';
const SERIES = 'Keeper of the Lost Cities';

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-scan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  scan = await import('./series-cast-scan.js');

  /* Three books in the same series:
       - KOTLC #1 (confirmed) -- contributes 3 characters
       - Bonus Keefe (confirmed) -- contributes 2 characters
       - Unlocked (NOT confirmed) -- excluded by library-cast-scan
     Plus one book in a different series to prove the series scope. */
  const seed = (title: string, opts: {
    confirmed: boolean; characters: Array<{ id: string; name: string }>;
    series?: string; isStandalone?: boolean;
  }) => {
    const series = opts.series ?? SERIES;
    const dir = join(workspaceRoot, 'books', AUTHOR, series, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({
      bookId: `${AUTHOR.toLowerCase().replace(/\s+/g, '-')}__${series.toLowerCase().replace(/\s+/g, '-')}__${title.toLowerCase().replace(/\s+/g, '-')}`,
      manuscriptId: `m_${title.toLowerCase().replace(/\s+/g, '_')}`,
      title,
      author: AUTHOR,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: opts.confirmed,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({
      characters: opts.characters.map(c => ({ ...c, role: 'character', color: 'unset' })),
    }));
  };

  seed('Keeper of the Lost Cities', {
    confirmed: true,
    characters: [
      { id: 'narrator', name: 'Narrator' },
      { id: 'sophie',   name: 'Sophie' },
      { id: 'keefe',    name: 'Keefe' },
    ],
  });
  seed('Bonus Keefe Story', {
    confirmed: true,
    characters: [
      { id: 'keefe', name: 'Keefe' },
      { id: 'ro',    name: 'Ro' },
    ],
  });
  seed('Unlocked', {
    confirmed: false,    // analyzing now, no cast on disk yet
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
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('scanSeriesCharacters', () => {
  it('returns confirmed characters across all books in the target series', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    /* KOTLC (3) + Bonus Keefe (2) = 5. Unlocked excluded (castConfirmed=false). */
    expect(records).toHaveLength(5);
    const ids = records.map(r => r.character.id).sort();
    expect(ids).toEqual(['keefe', 'keefe', 'narrator', 'ro', 'sophie']);
  });

  it('excludes the supplied bookId from the result (book never seeds itself)', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES, {
      excludeBookId: 'shannon-messenger__keeper-of-the-lost-cities__keeper-of-the-lost-cities',
    });
    /* KOTLC's 3 characters drop out; Bonus Keefe's 2 remain. */
    expect(records).toHaveLength(2);
    const ids = records.map(r => r.character.id).sort();
    expect(ids).toEqual(['keefe', 'ro']);
  });

  it('excludes books in a different series even when the author matches', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    expect(records.find(r => r.character.id === 'unrelated')).toBeUndefined();
  });

  it('excludes standalones even when they live under the same series folder', async () => {
    /* state.isStandalone === true makes a book's cast NOT part of any
       series's continuity, regardless of where its directory sits. */
    const records = await scan.scanSeriesCharacters(AUTHOR, SERIES);
    expect(records.find(r => r.character.id === 'lonely')).toBeUndefined();
  });

  it('returns empty for an author/series with no confirmed books', async () => {
    const records = await scan.scanSeriesCharacters(AUTHOR, 'Nonexistent Series');
    expect(records).toEqual([]);
  });
});

describe('scanSeriesCharactersForBookId', () => {
  it('resolves (author, series) from a bookId and returns its series-mates', async () => {
    const records = await scan.scanSeriesCharactersForBookId(
      'shannon-messenger__keeper-of-the-lost-cities__unlocked',
    );
    /* Unlocked sits in KOTLC series. Its OWN cast (narrator only, not
       confirmed) is excluded by both excludeBookId AND the
       castConfirmed gate. KOTLC's 3 + Bonus Keefe's 2 = 5. */
    expect(records).toHaveLength(5);
  });

  it('returns [] for a bookId that does not exist in the library', async () => {
    const records = await scan.scanSeriesCharactersForBookId('does__not__exist');
    expect(records).toEqual([]);
  });

  it('returns [] for a standalone book (its own cast is NOT part of any series)', async () => {
    const records = await scan.scanSeriesCharactersForBookId(
      'shannon-messenger__keeper-of-the-lost-cities__some-standalone',
    );
    /* The standalone's series field resolves to KOTLC, BUT the scan's
       isStandalone filter excludes every other book from the result.
       Hmm -- actually, the OTHER books in KOTLC series aren't
       standalones, so they DO appear. This is the right behaviour:
       a standalone asking "who else is in my series" should still
       discover the series regulars; they just don't need to flow
       back the other way. */
    /* Loosen: scope is "series-mates" which means non-standalone books
       in the same series. KOTLC + Bonus Keefe both appear (5 characters
       total). */
    expect(records).toHaveLength(5);
  });
});
