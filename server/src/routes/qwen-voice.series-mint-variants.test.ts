/* #4037 — the series mint re-keys a legacy voice (`qwen-v_wren`) to a fresh
   `qwen-<uuid>`. It must carry the emotion variants (`qwen-v_wren__angry.*`) with
   the base family, or the stamped rows ask for a `qwen-<uuid>__angry` that does not
   exist (`voice_not_designed` at synth). A failed copy of any file leaves nothing
   behind and stamps nothing. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Fails any copy whose destination contains this text (an EBUSY from a scanner). */
const failCopyTo = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const copyFile = async (src: unknown, dest: unknown, mode?: number) => {
    if (failCopyTo.text && String(dest).includes(failCopyTo.text)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${String(dest)}'`), {
        code: 'EBUSY',
        syscall: 'copyfile',
        path: String(dest),
      });
    }
    return actual.copyFile(src as string, dest as string, mode);
  };
  return { ...actual, default: { ...actual, copyFile }, copyFile };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const TITLES = ['Book One', 'Book Two'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
const ids = {} as Record<Title, string>;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRow = (title: string): Record<string, any> => JSON.parse(readFileSync(castPath(title), 'utf8')).characters[0];

const legacyRow = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  overrideTtsVoices: {
    qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } },
  },
};

function writeBook(title: Title, row: Record<string, unknown>) {
  const dir = bookDir(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: ids[title],
      manuscriptId: `m_${ids[title]}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(title) + 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(title), JSON.stringify({ characters: [row] }));
}

function seed() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(qwenDir(), { recursive: true, force: true });
  writeBook('Book One', { ...legacyRow });
  writeBook('Book Two', {
    ...legacyRow,
    matchedFrom: { bookId: ids['Book One'], characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
  });
  mkdirSync(qwenDir(), { recursive: true });
  for (const f of [
    'qwen-v_wren.pt',
    'qwen-v_wren.json',
    'qwen-v_wren__1.7b.pt',
    'qwen-v_wren__master.wav',
    'qwen-v_wren__angry.pt',
    'qwen-v_wren__angry.json',
    'qwen-v_wren__angry__1.7b.pt',
    'qwen-v_wren__angry__master.wav',
  ]) {
    writeFileSync(join(qwenDir(), f), `bytes of ${f}`);
  }
}

const mint = async () => {
  const { ensureCharacterVoiceUuid } = await import('./qwen-voice.js');
  return ensureCharacterVoiceUuid(bookDir('Book Two'), 'wren', { author: AUTHOR, series: SERIES });
};

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-series-mint-variants-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
});

beforeEach(() => {
  failCopyTo.text = null;
  seed();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('#4037 — the series mint copies a legacy voice’s emotion variants', () => {
  it('copies every variant file to qwen-<uuid>__<emotion>.* and the stamped rows name them', async () => {
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(readRow('Book One').voiceUuid).toBe(uuid);
    expect(readRow('Book Two').voiceUuid).toBe(uuid);

    for (const f of ['.pt', '.json', '__1.7b.pt', '__master.wav']) {
      expect(readFileSync(join(qwenDir(), `qwen-${uuid}__angry${f}`), 'utf8')).toBe(`bytes of qwen-v_wren__angry${f}`);
    }
    /* the base family copies as before, and the legacy files stay where they were */
    expect(existsSync(join(qwenDir(), `qwen-${uuid}.pt`))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_wren__angry.pt'))).toBe(true);
    /* the base's `__1.7b` / `__master` suffixes are not taken for emotions */
    expect(existsSync(join(qwenDir(), `qwen-${uuid}__1.7b__1.7b.pt`))).toBe(false);

    for (const t of TITLES) {
      expect(readRow(t).overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    }
  });

  it('re-keys the designing row’s variant names when its book is unconfirmed (stampOwnRow path)', async () => {
    const statePath = join(bookDir('Book Two'), '.audiobook', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, castConfirmed: false }));
    const uuid = await mint();
    /* the walk skips the unconfirmed designing book; stampOwnRow stamps it */
    expect(readRow('Book Two').voiceUuid).toBe(uuid);
    expect(readRow('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
  });

  it('a failed variant copy stamps nothing and leaves no copy behind', async () => {
    failCopyTo.text = '__angry__1.7b.pt';
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(readRow('Book One').voiceUuid).toBeUndefined();
    expect(readRow('Book Two').voiceUuid).toBeUndefined();
    expect(readRow('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
    expect(readdirSync(qwenDir()).filter((f) => !f.startsWith('qwen-v_wren'))).toEqual([]);
  });
});
