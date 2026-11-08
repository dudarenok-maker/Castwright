/* #4037 — the series mint (ensureCharacterVoiceUuid with a seriesFilter) copies a
   legacy voice key's emotion variants along with its base family, and renames the
   stamped rows' variant slots to the new key. On real cast.json files; the mint is
   called directly. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* T4 — makes a copy to `qwen-<anything>__angry.pt` fail with EBUSY. */
const failing = vi.hoisted(() => ({ on: false }));
/* T7 — runs just before a copy, so a variant can land inside the mint's copy-to-walk window. */
const hook = vi.hoisted(() => ({ fn: null as null | ((dest: string) => Promise<void>) }));
/* T14 — makes the cast.json write (its tmp file) fail with ENOSPC. */
const castWriteFails = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: (async (src: string, dest: string, ...rest: unknown[]) => {
      if (hook.fn) await hook.fn(String(dest));
      if (failing.on && /qwen-[^\\/]+__angry\.pt$/.test(String(dest))) {
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
      }
      return (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest);
    }) as typeof actual.copyFile,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      if (castWriteFails.on && /cast\.json\.tmp-/.test(String(path))) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof actual.writeFile,
  };
});
/* T13 — makes a synchronous copy of an `__excited.json` member fail with EBUSY. */
const syncCopyFails = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const copyFileSync = ((src: string, dest: string, mode?: number) => {
    if (syncCopyFails.on && /__excited\.json/.test(String(dest))) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return actual.copyFileSync(src, dest, mode);
  }) as typeof actual.copyFileSync;
  return { ...actual, default: { ...actual, copyFileSync }, copyFileSync };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

let workspaceRoot: string;
let ensure: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;
let persistVariant: typeof import('./qwen-voice.js').persistEmotionVariant;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const SOLO_SERIES = 'Standalones';
const bookDir = (t: string, series = SERIES) => join(workspaceRoot, 'books', AUTHOR, series, t);
const castPath = (t: string, series = SERIES) => join(bookDir(t, series), '.audiobook', 'cast.json');
const rowOf = (t: string, series = SERIES): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t, series), 'utf8')).characters.find((c: { id: string }) => c.id === 'wren');
const file = (name: string) => join(qwenDir(), name);
const plant = (name: string, body: string) => writeFileSync(file(name), Buffer.from(body));

function writeBook(
  t: string,
  rows: Array<Record<string, unknown>>,
  opts: { confirmed?: boolean; standalone?: boolean } = {},
) {
  const series = opts.standalone ? SOLO_SERIES : SERIES;
  const dir = bookDir(t, series);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `b_${t}`,
      manuscriptId: `m_${t}`,
      title: t,
      author: AUTHOR,
      series,
      seriesPosition: 1,
      isStandalone: opts.standalone === true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: opts.confirmed !== false,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(t, series), JSON.stringify({ characters: rows }));
}

const legacy = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  gender: 'female',
  ageRange: 'adult',
};
const withVariants = (variants: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...legacy,
  ...extra,
  overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants } },
});

function seed(oneRow: Record<string, unknown>) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeBook('Book One', [oneRow]);
  writeBook('Book Two', [{ ...legacy }]);
}
const plantBase = () => {
  plant('qwen-v_wren.pt', 'BASE-PT');
  plant('qwen-v_wren.json', 'BASE-JSON');
  plant('qwen-v_wren__1.7b.pt', 'BASE-17B');
  plant('qwen-v_wren__master.wav', 'BASE-WAV');
};
const plantAngry = () => {
  plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
  plant('qwen-v_wren__angry.json', 'ANGRY-JSON');
};
const mint = () => ensure(bookDir('Book Two'), 'wren', { author: AUTHOR, series: SERIES });
const legacyFiles = [
  'qwen-v_wren.pt',
  'qwen-v_wren.json',
  'qwen-v_wren__1.7b.pt',
  'qwen-v_wren__master.wav',
  'qwen-v_wren__angry.pt',
  'qwen-v_wren__angry.json',
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-mint-variants-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  ({ ensureCharacterVoiceUuid: ensure, persistEmotionVariant: persistVariant } = await import('./qwen-voice.js'));
});
beforeEach(() => {
  failing.on = false;
  castWriteFails.on = false;
  syncCopyFails.on = false;
  hook.fn = null;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('series mint copies emotion variants (#4037)', () => {
  it('T1: copies the angry family, renames the stamped slot, keeps the legacy files', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(readFileSync(file(`qwen-${uuid}__angry.pt`), 'utf8')).toBe('ANGRY-PT');
    expect(readFileSync(file(`qwen-${uuid}__angry.json`), 'utf8')).toBe('ANGRY-JSON');
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(readFileSync(file(`qwen-${uuid}.pt`), 'utf8')).toBe('BASE-PT');
    for (const f of legacyFiles) expect(existsSync(file(f))).toBe(true);
    expect(readFileSync(file('qwen-v_wren__angry.pt'), 'utf8')).toBe('ANGRY-PT');
  });

  it('T2: a foreign variant name is kept', async () => {
    seed(
      withVariants({
        angry: { name: 'qwen-v_wren__angry' },
        sad: { name: 'qwen-u_other__sad' },
      }),
    );
    plantBase();
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-PT'); // a file the foreign name could be mistaken for
    await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_other__sad');
  });

  it('T3: nothing to copy (no base .pt) copies no variant and stamps only the designing row', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    await mint();
    expect(readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-') && f !== 'qwen-v_wren__angry.pt')).toEqual([]);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('T4: a failing variant copy removes every earlier copy and stamps nothing', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    failing.on = true;
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
  });

  it('T5: a row with its own uuid keeps both uuid and variant names', async () => {
    /* The shape every row the pre-#4037 mint stamped has: a uuid, and a slot still
       named for the legacy key, whose legacy file is the only copy of those bytes. */
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }, { voiceUuid: 'u_own' }));
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(rowOf('Book One').voiceUuid).toBe('u_own');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('T6: a designing book whose cast is unconfirmed (stampOwnRow) renames its own slot', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [withVariants({ angry: { name: 'qwen-v_wren__angry' } })], { confirmed: false });
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(rowOf('Book Two').voiceUuid).toBe(uuid);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(existsSync(file(`qwen-${uuid}__angry.pt`))).toBe(true);
  });

  it('T7: a variant landing on another book between the copy and the walk gets its file copied, then renamed', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest) => {
      /* the last copy attempt of the copy loop */
      if (!fired && /qwen-[^\\/]+__sad__master\.wav$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-PT');
        const out = await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', {
          author: AUTHOR,
          series: SERIES,
        });
        expect(out).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-PT');
    expect(existsSync(file('qwen-v_wren__sad.pt'))).toBe(true);
  });

  it('T11: a variant REdesign landing between the copy and the walk reaches the renamed slot', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', 'SAD-OLD-J');
    let fired = false;
    hook.fn = async (dest) => {
      /* the copy loop's last attempt: the old sad family is already copied */
      if (!fired && /qwen-[^\\/]+__sad__master\.wav$/.test(dest)) {
        fired = true;
        /* the user's sad redesign on Book One lands (same size as the old bytes), then persists */
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plant('qwen-v_wren__sad.json', 'SAD-NEW-J');
        const out = await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', {
          author: AUTHOR,
          series: SERIES,
        });
        expect(out).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-NEW');
    expect(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).toBe('SAD-NEW-J');
    expect(readFileSync(file('qwen-v_wren__sad.pt'), 'utf8')).toBe('SAD-NEW');
  });

  it('T12: a landing straddling one emotion of the copy loop (.json copied, .pt not) completes cleanly', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest) => {
      /* between the mint's sad.pt attempt (nothing there yet) and its sad.json attempt */
      if (!fired && /qwen-[^\\/]+__sad\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-PT');
        plant('qwen-v_wren__sad.json', 'SAD-JSON');
        const out = await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', {
          author: AUTHOR,
          series: SERIES,
        });
        expect(out).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-PT');
    expect(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).toBe('SAD-JSON');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('T13: a failing in-lock copy with nothing stamped removes every copy, the in-lock ones too', async () => {
    /* sad and excited land after the copy loop; in the walk, sad's in-lock copy
       succeeds and excited's .json copy fails, before any row is stamped. */
    seed(
      withVariants({
        angry: { name: 'qwen-v_wren__angry' },
        sad: { name: 'qwen-v_wren__sad' },
        excited: { name: 'qwen-v_wren__excited' },
      }),
    );
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest) => {
      if (!fired && /qwen-[^\\/]+__sad__master\.wav$/.test(dest)) {
        fired = true;
        for (const e of ['sad', 'excited']) {
          plant(`qwen-v_wren__${e}.pt`, `${e}-PT`);
          plant(`qwen-v_wren__${e}.json`, `${e}-JSON`);
        }
      }
    };
    syncCopyFails.on = true;
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(fired).toBe(true);
    const extra = ['sad', 'excited'].flatMap((e) => [`qwen-v_wren__${e}.pt`, `qwen-v_wren__${e}.json`]);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles, ...extra].sort());
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
  });

  it('T15: a new-key variant file the mint did not write is never overwritten', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    let fired = false;
    hook.fn = async (dest) => {
      const m = /qwen-([^\\/]+)__sad__master\.wav$/.exec(dest);
      if (!fired && m) {
        fired = true;
        /* something else designed sad on the new key, and the legacy key changed too */
        plant(`qwen-${m[1]}__sad.pt`, 'SAD-OWN');
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-OWN');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
  });

  it('T7b: a slot whose legacy file is gone keeps its legacy name', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-v_wren__sad');
  });
});

describe('book-scoped mint copies the legacy family too (#4037)', () => {
  const soloSeed = (row: Record<string, unknown>) => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    mkdirSync(qwenDir(), { recursive: true });
    writeBook('Solo', [row], { standalone: true });
  };

  it('T8: a standalone legacy row gets the base and angry copied under the new key, slot renamed', async () => {
    soloSeed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    const uuid = await ensure(bookDir('Solo', SOLO_SERIES), 'wren');
    expect(uuid).toBeTruthy();
    expect(rowOf('Solo', SOLO_SERIES).voiceUuid).toBe(uuid);
    expect(readFileSync(file(`qwen-${uuid}.pt`), 'utf8')).toBe('BASE-PT');
    expect(readFileSync(file(`qwen-${uuid}__angry.pt`), 'utf8')).toBe('ANGRY-PT');
    expect(rowOf('Solo', SOLO_SERIES).overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    for (const f of legacyFiles) expect(existsSync(file(f))).toBe(true);
  });

  it('T9: nothing designed under the legacy key stamps as before and copies nothing', async () => {
    soloSeed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    const uuid = await ensure(bookDir('Solo', SOLO_SERIES), 'wren');
    expect(rowOf('Solo', SOLO_SERIES).voiceUuid).toBe(uuid);
    expect(readdirSync(qwenDir())).toEqual(['qwen-v_wren__angry.pt']);
    expect(rowOf('Solo', SOLO_SERIES).overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('T10: a failing variant copy removes the earlier copies and stamps nothing', async () => {
    soloSeed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    failing.on = true;
    await expect(ensure(bookDir('Solo', SOLO_SERIES), 'wren')).rejects.toThrow(/EBUSY/);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
    expect(rowOf('Solo', SOLO_SERIES).voiceUuid).toBeUndefined();
  });

  it('T14: a failing cast write removes the copies and stamps nothing', async () => {
    soloSeed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    castWriteFails.on = true;
    await expect(ensure(bookDir('Solo', SOLO_SERIES), 'wren')).rejects.toThrow(/ENOSPC/);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
    expect(rowOf('Solo', SOLO_SERIES).voiceUuid).toBeUndefined();
  });
});
