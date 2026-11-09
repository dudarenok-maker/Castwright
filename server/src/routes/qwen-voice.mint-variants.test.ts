/* #4037 — the series mint (ensureCharacterVoiceUuid with a seriesFilter) copies a
   legacy voice key's emotion variants along with its base family, and renames the
   stamped rows' variant slots to the new key; T7-T15 pin what a variant landing on
   another book of the series inside the mint's copy-to-walk window leaves behind.
   On real cast.json files; the mint is called directly. Ported from PR #4052. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* T4 — makes a copy to `qwen-<anything>__angry.pt` fail with EBUSY. */
const failing = vi.hoisted(() => ({ on: false }));
/* T7 — runs just before ('before') or just after ('after') a copy, so a variant can
   land inside the mint's copy-to-walk window. */
const hook = vi.hoisted(() => ({ fn: null as null | ((dest: string, phase: 'before' | 'after') => Promise<void>) }));
/* T14 — makes the cast.json write (its tmp file) fail with ENOSPC. */
const castWriteFails = vi.hoisted(() => ({ on: false }));
/* #4037 — runs after a cast.json tmp file is written (a book's stamp is about to land). */
const castWritten = vi.hoisted(() => ({ fn: null as null | ((path: string) => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: (async (src: string, dest: string, ...rest: unknown[]) => {
      if (hook.fn) await hook.fn(String(dest), 'before');
      if (failing.on && /qwen-[^\\/]+__angry\.pt$/.test(String(dest))) {
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
      }
      await (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest);
      if (hook.fn) await hook.fn(String(dest), 'after');
    }) as typeof actual.copyFile,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      if (castWriteFails.on && /cast\.json\.tmp-/.test(String(path))) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      }
      await (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
      if (castWritten.fn && /cast\.json\.tmp-/.test(String(path))) castWritten.fn(String(path));
    }) as typeof actual.writeFile,
  };
});
/* T13 — makes a synchronous copy of an `__excited.json` member fail with EBUSY. */
const syncCopyFails = vi.hoisted(() => ({ on: false }));
const renameFails = vi.hoisted(() => ({ hard: false, transient: 0 }));
/* #4037 — sees every synchronous rename's source before it runs. */
const renameSeen = vi.hoisted(() => ({ fn: null as null | ((from: string, to: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const copyFileSync = ((src: string, dest: string, mode?: number) => {
    if (syncCopyFails.on && /__excited\.json/.test(String(dest))) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return actual.copyFileSync(src, dest, mode);
  }) as typeof actual.copyFileSync;
  /* #4037 — `hard` makes a rename onto `qwen-<anything>__sad.json` fail for good (EINVAL);
     `transient` makes the next rename onto a `__sad.pt` fail that many times with EBUSY. */
  const renameSync = ((from: string, to: string) => {
    renameSeen.fn?.(String(from), String(to));
    if (renameFails.hard && /qwen-[^\\/]+__sad\.json$/.test(String(to))) {
      throw Object.assign(new Error('EINVAL: invalid argument, rename'), { code: 'EINVAL' });
    }
    if (renameFails.transient > 0 && /qwen-[^\\/]+__sad\.pt$/.test(String(to))) {
      renameFails.transient -= 1;
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    }
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, default: { ...actual, copyFileSync, renameSync }, copyFileSync, renameSync };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

let workspaceRoot: string;
let ensure: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;
let persistVariant: typeof import('./qwen-voice.js').persistEmotionVariant;
let dropStale: typeof import('../workspace/variant-base-rev.js').dropStaleVariants;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const SOLO_SERIES = 'Standalones';
const bookDir = (t: string, series = SERIES) => join(workspaceRoot, 'books', AUTHOR, series, t);
const castPath = (t: string, series = SERIES) => join(bookDir(t, series), '.audiobook', 'cast.json');
const rowOf = (t: string, series = SERIES): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t, series), 'utf8')).characters.find((c: { id: string }) => c.id === 'wren');
const file = (name: string) => join(qwenDir(), name);
const plant = (name: string, body: string) => writeFileSync(file(name), Buffer.from(body));
/* #4040 — a sidecar json: a base carries `rev`, a variant the `baseRev` it was made from. */
const plantJson = (name: string, json: Record<string, unknown>) => plant(name, JSON.stringify(json));
/* #4040 — is the row's `emotion` slot still in use (not dropped as stale)? */
const keptSlot = async (t: string, emotion: string): Promise<boolean> => {
  const [row] = await dropStale([rowOf(t)]);
  return !!(row as Record<string, any>).overrideTtsVoices?.qwen?.variants?.[emotion];
};

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
  ({ dropStaleVariants: dropStale } = await import('../workspace/variant-base-rev.js'));
});
beforeEach(() => {
  failing.on = false;
  castWriteFails.on = false;
  syncCopyFails.on = false;
  renameFails.hard = false;
  renameFails.transient = 0;
  castWritten.fn = null;
  renameSeen.fn = null;
  hook.fn = null;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('series mint copies emotion variants (#4037)', () => {
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

  it('T7: a variant landing on another book between the copy and the walk gets its file copied, then renamed', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest, phase) => {
      /* right after the copy loop's last copy */
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
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

  it('T11: a variant REdesign landing between the copy and the walk reaches the renamed slot, current (#4040)', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R0' }); // made from an older base: stale
    let fired = false;
    hook.fn = async (dest, phase) => {
      /* right after the copy loop's last copy: the old sad family is already copied */
      if (!fired && phase === 'after' && /qwen-[^\\/]+__sad\.json$/.test(dest)) {
        fired = true;
        /* the user's sad redesign on Book One lands (same size as the old bytes), then persists */
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
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
    expect(JSON.parse(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).baseRev).toBe('R1');
    expect(readFileSync(file('qwen-v_wren__sad.pt'), 'utf8')).toBe('SAD-NEW');
    /* #4040 — the redesign stays current against the base it was designed from */
    expect(await keptSlot('Book One', 'sad')).toBe(true);
    expect(await keptSlot('Book Two', 'sad')).toBe(true);
  });

  it('T12: a landing straddling the copy loop (its .pt listed, its .json not yet) completes whole and current', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plantAngry();
    /* a first sad design is landing: its .pt has moved, its .json not yet */
    plant('qwen-v_wren__sad.pt', 'SAD-PT');
    let fired = false;
    hook.fn = async (dest, phase) => {
      /* after the listing (the first variant copy), the landing's .json moves and it persists */
      if (!fired && phase === 'before' && /qwen-[^\\/]+__angry\.pt$/.test(dest)) {
        fired = true;
        plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
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
    expect(JSON.parse(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).baseRev).toBe('R1');
    expect(await keptSlot('Book One', 'sad')).toBe(true);
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
    hook.fn = async (dest, phase) => {
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
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
    plant('qwen-v_wren__sad.json', 'SAD-OLD-J');
    let fired = false;
    hook.fn = async (dest, phase) => {
      /* before the sad .json copy: the mint's sad .pt copy has landed and been printed */
      const m = /qwen-([^\\/]+)__sad\.json$/.exec(dest);
      if (!fired && phase === 'before' && m) {
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

  it('T17: every stamped row names the new key once its base was copied there', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [withVariants({})]);
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
    expect(existsSync(file(`qwen-${uuid}.pt`))).toBe(true);
  });

  it('T18: with no base copied, the stamped designing row keeps its legacy name', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [withVariants({})], { confirmed: false });
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    const uuid = await mint();
    expect(rowOf('Book Two').voiceUuid).toBe(uuid);
    expect(existsSync(file(`qwen-${uuid}.pt`))).toBe(false);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe('qwen-v_wren');
  });

  it('T19: a library slot keeps its name, and a designing row stamped by stampOwnRow is renamed', async () => {
    seed({ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren', libraryUuid: 'lib_1' } } });
    writeBook('Book Two', [withVariants({})], { confirmed: false });
    plantBase();
    const uuid = await mint();
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.name).toBe('qwen-v_wren');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
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

  it('T16: a failing in-lock copy removes every copy, the in-lock ones too, and stamps nothing', async () => {
    soloSeed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, excited: { name: 'qwen-v_wren__excited' } }));
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest, phase) => {
      /* after the copy loop's last copy, a landing on the legacy key (another book on it) */
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__angry.pt', 'ANGRY-NEW');
        plant('qwen-v_wren__excited.pt', 'EXCITED-PT');
        plant('qwen-v_wren__excited.json', 'EXCITED-JSON');
      }
    };
    syncCopyFails.on = true;
    await expect(ensure(bookDir('Solo', SOLO_SERIES), 'wren')).rejects.toThrow(/EBUSY/);
    expect(fired).toBe(true);
    const extra = ['qwen-v_wren__excited.pt', 'qwen-v_wren__excited.json'];
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles, ...extra].sort());
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

describe('a series mint whose stamp never lands leaves no copy behind (#4062)', () => {
  const onlyLegacy = () => expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());

  it('S1: a failing cast write on the walk removes every copy, the base family too', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    castWriteFails.on = true;
    await expect(mint()).rejects.toThrow(/ENOSPC/);
    onlyLegacy();
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
  });

  it('S2: a later row of the same book whose transform throws removes every copy', async () => {
    /* row A stamps cleanly; row B (same link id, same book) meets an excited variant that
       landed after the copy loop, whose in-lock copy fails: the book's write never happens */
    const rowA = withVariants({ angry: { name: 'qwen-v_wren__angry' } });
    const rowB = { ...withVariants({ excited: { name: 'qwen-v_wren__excited' } }), id: 'wren2' };
    seed(rowA);
    writeBook('Book One', [rowA, rowB]);
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest, phase) => {
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__excited.pt', 'excited-PT');
        plant('qwen-v_wren__excited.json', 'excited-JSON');
      }
    };
    syncCopyFails.on = true;
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(fired).toBe(true);
    expect(readdirSync(qwenDir()).sort()).toEqual(
      [...legacyFiles, 'qwen-v_wren__excited.pt', 'qwen-v_wren__excited.json'].sort(),
    );
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
  });

  it('S3: the designing row gone when stampOwnRow runs, with no book stamped, removes every copy', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book One', [{ ...legacy }], { confirmed: false });
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest, phase) => {
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [] }));
      }
    };
    expect(await mint()).toBeUndefined();
    expect(fired).toBe(true);
    onlyLegacy();
  });

  it('S4: the designing row already stamped by a decline, with no book stamped, removes every copy', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book One', [{ ...legacy }], { confirmed: false });
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.fn = async (dest, phase) => {
      if (!fired && phase === 'after' && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_decl' }] }));
      }
    };
    expect(await mint()).toBe('u_decl');
    expect(fired).toBe(true);
    onlyLegacy();
    expect(rowOf('Book Two').voiceUuid).toBe('u_decl');
  });
});

describe('a refresh of the mint copy replaces the family whole, or not at all (#4037)', () => {
  const sadSeed = () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R0' });
  };
  /* a redesign of sad lands on the legacy key right after Book One (walked first) is stamped */
  const redesignAfterBookOne = () => {
    let fired = false;
    castWritten.fn = (path) => {
      if (!fired && path.includes('Book One')) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
      }
    };
    return () => fired;
  };

  it('R1: a failing .json rename after the .pt one leaves the stamped book a whole, old family', async () => {
    sadSeed();
    const fired = redesignAfterBookOne();
    renameFails.hard = true;
    await expect(mint()).rejects.toThrow(/EINVAL/);
    expect(fired()).toBe(true);
    const uuid = rowOf('Book One').voiceUuid;
    expect(uuid).toBeTruthy();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-OLD');
    expect(JSON.parse(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).baseRev).toBe('R0');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp') || f.includes('.bak'))).toEqual([]);
  });

  it('R2: a transient EBUSY on the .pt rename is retried and the family is refreshed', async () => {
    sadSeed();
    const fired = redesignAfterBookOne();
    renameFails.transient = 2;
    const uuid = await mint();
    expect(fired()).toBe(true);
    expect(renameFails.transient).toBe(0);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-NEW');
    expect(JSON.parse(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).baseRev).toBe('R1');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp') || f.includes('.bak'))).toEqual([]);
  });
});

/* A variant that LANDED on the legacy key while a mint walked (its family planted after the
   copy loops, persist not yet called) and is recorded only after the walk re-keyed
   the rows: the real route order, persist trailing the walk. */
describe('a variant recorded after the mint re-keyed the rows follows the mint (#4037)', () => {
  const plantLanding = (emotion: string) => {
    plant(`qwen-v_wren__${emotion}.pt`, `${emotion.toUpperCase()}-PT`);
    plantJson(`qwen-v_wren__${emotion}.json`, { baseRev: 'R1' });
  };
  const mintWithLanding = async (emotions: string[]) => {
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    let fired = false;
    /* after the copy loops, as the walk's first stamp is about to land */
    castWritten.fn = () => {
      if (fired) return;
      fired = true;
      emotions.forEach(plantLanding);
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    return uuid;
  };
  const series = { author: AUTHOR, series: SERIES };

  it('T20: the take lands on every linked book at the new key, whole and current', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    expect(existsSync(file(`qwen-${uuid}__sad.pt`))).toBe(false); // nothing copied it: persist has not run
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    for (const t of ['Book One', 'Book Two']) {
      expect(rowOf(t).overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
      expect(await keptSlot(t, 'sad')).toBe(true);
    }
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-PT');
    expect(JSON.parse(readFileSync(file(`qwen-${uuid}__sad.json`), 'utf8')).baseRev).toBe('R1');
    expect(existsSync(file('qwen-v_wren__sad.pt'))).toBe(true);
  });

  it('T21: a book that "Don\'t reuse" separated gets no take and no file', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
    await recordSeparatedVoice('u_sep');
    const cast = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    cast.characters[0] = { ...cast.characters[0], voiceUuid: 'u_sep', declinedVoiceFrom: ['b_Book Two'] };
    writeFileSync(castPath('Book One'), JSON.stringify(cast));
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(rowOf('Book One').overrideTtsVoices?.qwen?.variants?.sad).toBeUndefined();
    expect(existsSync(file('qwen-u_sep__sad.pt'))).toBe(false);
  });

  it('T22: interleaved persists give every linked book every take', async () => {
    seed(withVariants({}));
    writeBook('Book Three', [{ ...legacy }]);
    const uuid = await mintWithLanding(['sad', 'excited']);
    const outs = await Promise.all([
      persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', series),
      persistVariant(bookDir('Book Three'), 'wren', 'excited', 'qwen-v_wren__excited', series),
    ]);
    expect(outs).toEqual(['applied', 'applied']);
    for (const t of ['Book One', 'Book Two', 'Book Three']) {
      expect(rowOf(t).overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
      expect(rowOf(t).overrideTtsVoices.qwen.variants.excited.name).toBe(`qwen-${uuid}__excited`);
    }
    expect(readFileSync(file(`qwen-${uuid}__excited.pt`), 'utf8')).toBe('EXCITED-PT');
  });

  it('T23: a standalone book follows its own mint too', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    mkdirSync(qwenDir(), { recursive: true });
    writeBook('Solo', [withVariants({})], { standalone: true });
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    const uuid = (await ensure(bookDir('Solo', SOLO_SERIES), 'wren'))!;
    plantLanding('sad');
    expect(await persistVariant(bookDir('Solo', SOLO_SERIES), 'wren', 'sad', 'qwen-v_wren__sad')).toBe('applied');
    expect(rowOf('Solo', SOLO_SERIES).overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(readFileSync(file(`qwen-${uuid}__sad.pt`), 'utf8')).toBe('SAD-PT');
  });
});

/* A copy keeps its source's mtime on Windows, so a copy of an old file reads old to the
   startup sweep's one-hour guard. The mint stamps every copy it makes with the time it
   made it. */
describe('the mint stamps its copies fresh, so the startup sweep leaves them alone (#4037)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const age = (path: string): number => Date.now() - statSync(path).mtimeMs;
  const makeOld = (path: string) => {
    const t = new Date(Date.now() - 3 * DAY_MS);
    utimesSync(path, t, t);
  };

  it('F1: a variant family copied from an old source reads fresh to the startup sweep', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    for (const f of legacyFiles) makeOld(file(f));
    const { sweepOrphanVariantFiles } = await import('./qwen-voice.js');
    const uuid = await mint();
    const copies = ['pt', 'json'].map((x) => file(`qwen-${uuid}__angry.${x}`));
    for (const c of copies) expect(age(c), c).toBeLessThan(60_000);
    /* in the window before a row names the copies, nothing does */
    for (const t of ['Book One', 'Book Two']) writeBook(t, [{ ...legacy }]);
    /* only the old, unnamed legacy angry files go (.pt, .json), never the fresh copies */
    expect(await sweepOrphanVariantFiles()).toBe(2);
    for (const c of copies) expect(existsSync(c)).toBe(true);
  });

  /* a redesign of sad lands on the legacy key after Book One is stamped; the mint copy
     of the old sad is aged so a refresh has to back it up and replace it */
  const refreshFromOldSources = () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R0' });
    let fired = false;
    castWritten.fn = (path) => {
      if (fired || !path.includes('Book One')) return;
      fired = true;
      plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
      for (const f of readdirSync(qwenDir()).filter((n) => /__sad\.(pt|json)$/.test(n))) makeOld(file(f));
    };
    const seen: Array<{ from: string; ageMs: number }> = [];
    renameSeen.fn = (from) => {
      if (/\.mint-[A-Za-z0-9_-]{6}\.tmp$/.test(from)) seen.push({ from, ageMs: age(from) });
    };
    return seen;
  };

  it('F2: a refresh stamps its temp copies fresh, whatever the age of the source', async () => {
    const seen = refreshFromOldSources();
    await mint();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.ageMs, s.from).toBeLessThan(60_000);
  });

  it('F3: a refresh stamps its backups fresh, whatever the age of the file it replaces', async () => {
    const seen = refreshFromOldSources();
    renameFails.hard = true; // the .json rename fails: the .pt is put back from its backup
    await expect(mint()).rejects.toThrow(/EINVAL/);
    /* the .pt temp renamed over the copy, then its backup renamed back over it */
    expect(seen.filter((x) => x.from.includes('__sad.pt.mint-')).length).toBe(2);
    for (const s of seen) expect(s.ageMs, s.from).toBeLessThan(60_000);
  });
});
