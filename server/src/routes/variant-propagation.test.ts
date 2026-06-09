/* Linked-cast emotion-variant propagation (fe-32 / srv-37).
 *
 * A designed emotion variant is just another voiceId derived from the
 * series-unified base voiceId (`qwen-<voiceId>__<emotion>`), so — exactly like
 * the base voice carried by `applyOverrideToCastFiles` — it MUST travel to
 * every linked character (same `voiceId`) across the books in the series. A
 * per-book variant slot would break the linked-cast premise (the same character
 * would render the emotion in one book and fall back to base in another).
 *
 * These tests pin:
 *   1. `persistEmotionVariant` with a seriesFilter writes the slot to every
 *      linked character across the series, and ONLY within the series
 *      (other-series + standalone books untouched).
 *   2. `applyOverrideToCastFiles` no longer wipes designed `variants` when it
 *      (re)assigns the base name — a base re-design or its series propagation
 *      must preserve the variants.
 *   3. Without a seriesFilter (standalone) the write stays book-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Della Renwick';
const SERIES = 'Keeper';
const OTHER_SERIES = 'Unrelated';

let workspaceRoot: string;
let booksRoot: string;
let persistEmotionVariant: typeof import('./qwen-voice.js').persistEmotionVariant;
let applyOverrideToCastFiles: typeof import('./voices.js').applyOverrideToCastFiles;

/** Lay a confirmed book on disk under books/<author>/<series>/<title>. */
function writeBook(
  author: string,
  series: string,
  title: string,
  chars: object[],
  opts: { isStandalone?: boolean; castConfirmed?: boolean } = {},
): string {
  const bookDir = join(booksRoot, author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `${author}__${series}__${title}`,
      title,
      author,
      series,
      isStandalone: opts.isStandalone ?? false,
      castConfirmed: opts.castConfirmed ?? true,
      chapters: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
  return bookDir;
}

function readCast(bookDir: string): { characters: Array<Record<string, any>> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}
function MarlowOf(bookDir: string) {
  return readCast(bookDir).characters.find((c) => c.id === 'Marlow');
}

/** Marlow with a designed qwen base — the linked identity is `voiceId: v_Marlow`. */
function MarlowWithBase() {
  return {
    id: 'Marlow',
    name: 'Marlow',
    voiceId: 'v_Marlow',
    voiceStyle: 'a sardonic, charming teenage boy',
    overrideTtsVoices: { qwen: { name: 'qwen-v_Marlow' } },
  };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'variant-prop-'));
  booksRoot = join(workspaceRoot, 'books');
  process.env.WORKSPACE_DIR = workspaceRoot;
  ({ persistEmotionVariant } = await import('./qwen-voice.js'));
  ({ applyOverrideToCastFiles } = await import('./voices.js'));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(booksRoot, { recursive: true, force: true });
});

describe('persistEmotionVariant — linked-cast propagation', () => {
  it('travels the variant to every linked character across the series', async () => {
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [MarlowWithBase()]);
    const bookTwo = writeBook(AUTHOR, SERIES, 'Book Two', [MarlowWithBase()]);

    await persistEmotionVariant(bookOne, 'Marlow', 'angry', 'qwen-v_Marlow__angry', {
      author: AUTHOR,
      series: SERIES,
    });

    /* Both linked books carry the variant — the originating book AND its sibling. */
    expect(MarlowOf(bookOne)?.overrideTtsVoices?.qwen?.variants?.angry).toEqual({
      name: 'qwen-v_Marlow__angry',
    });
    expect(MarlowOf(bookTwo)?.overrideTtsVoices?.qwen?.variants?.angry).toEqual({
      name: 'qwen-v_Marlow__angry',
    });
  });

  it('does not touch a different series or a standalone book', async () => {
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [MarlowWithBase()]);
    const otherSeries = writeBook(AUTHOR, OTHER_SERIES, 'Spin-off', [MarlowWithBase()]);
    const standalone = writeBook(AUTHOR, SERIES, 'Standalone', [MarlowWithBase()], {
      isStandalone: true,
    });

    await persistEmotionVariant(bookOne, 'Marlow', 'angry', 'qwen-v_Marlow__angry', {
      author: AUTHOR,
      series: SERIES,
    });

    expect(MarlowOf(bookOne)?.overrideTtsVoices?.qwen?.variants?.angry).toBeDefined();
    expect(MarlowOf(otherSeries)?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
    expect(MarlowOf(standalone)?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('bootstraps the qwen base name on a linked sibling that lacks the slot', async () => {
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [MarlowWithBase()]);
    /* Sibling has the linked identity but no qwen override yet. */
    const bookTwo = writeBook(AUTHOR, SERIES, 'Book Two', [
      { id: 'Marlow', name: 'Marlow', voiceId: 'v_Marlow' },
    ]);

    await persistEmotionVariant(bookOne, 'Marlow', 'sad', 'qwen-v_Marlow__sad', {
      author: AUTHOR,
      series: SERIES,
    });

    const sibling = MarlowOf(bookTwo)?.overrideTtsVoices?.qwen;
    expect(sibling?.name).toBe('qwen-v_Marlow');
    expect(sibling?.variants?.sad).toEqual({ name: 'qwen-v_Marlow__sad' });
  });

  it('preserves sibling variants when adding another emotion across the series', async () => {
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [MarlowWithBase()]);
    const bookTwo = writeBook(AUTHOR, SERIES, 'Book Two', [MarlowWithBase()]);
    const filter = { author: AUTHOR, series: SERIES };

    await persistEmotionVariant(bookOne, 'Marlow', 'angry', 'qwen-v_Marlow__angry', filter);
    await persistEmotionVariant(bookOne, 'Marlow', 'sad', 'qwen-v_Marlow__sad', filter);

    for (const dir of [bookOne, bookTwo]) {
      expect(Object.keys(MarlowOf(dir)?.overrideTtsVoices?.qwen?.variants ?? {}).sort()).toEqual([
        'angry',
        'sad',
      ]);
    }
  });

  it('stays book-scoped when no seriesFilter is given', async () => {
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [MarlowWithBase()]);
    const bookTwo = writeBook(AUTHOR, SERIES, 'Book Two', [MarlowWithBase()]);

    await persistEmotionVariant(bookOne, 'Marlow', 'angry', 'qwen-v_Marlow__angry');

    expect(MarlowOf(bookOne)?.overrideTtsVoices?.qwen?.variants?.angry).toBeDefined();
    expect(MarlowOf(bookTwo)?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
});

describe('applyOverrideToCastFiles — preserves designed variants', () => {
  it('keeps variants when (re)assigning the base name across the series', async () => {
    const withVariant = () => ({
      id: 'Marlow',
      name: 'Marlow',
      voiceId: 'v_Marlow',
      overrideTtsVoices: {
        qwen: { name: 'qwen-v_Marlow', variants: { angry: { name: 'qwen-v_Marlow__angry' } } },
      },
    });
    const bookOne = writeBook(AUTHOR, SERIES, 'Book One', [withVariant()]);
    const bookTwo = writeBook(AUTHOR, SERIES, 'Book Two', [withVariant()]);

    await applyOverrideToCastFiles(
      'v_Marlow',
      { engine: 'qwen', name: 'qwen-v_Marlow' },
      { author: AUTHOR, series: SERIES },
    );

    for (const dir of [bookOne, bookTwo]) {
      const qwen = MarlowOf(dir)?.overrideTtsVoices?.qwen;
      expect(qwen?.name).toBe('qwen-v_Marlow');
      expect(qwen?.variants?.angry).toEqual({ name: 'qwen-v_Marlow__angry' });
    }
  });
});
