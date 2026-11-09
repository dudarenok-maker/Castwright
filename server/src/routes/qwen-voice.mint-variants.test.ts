/* #4037 / #4062 — the races and rollbacks of the legacy-key mint
   (ensureCharacterVoiceUuid) that its own suites (qwen-voice.series-mint-variants,
   qwen-voice.standalone-mint-variants) do not reach: a variant that lands on
   another book of the series between the mint's up-front copy and the walk's step
   for that book, a cast write that fails, and the row shapes the re-key must leave
   alone. On real cast.json files; the mint is called directly. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Runs just before / just after each async copy (the mint's up-front copy), so a
   variant can land inside the mint's copy-to-walk window. */
const hook = vi.hoisted(() => ({
  pre: null as null | ((dest: string) => Promise<void>),
  post: null as null | ((dest: string) => Promise<void>),
}));
/* Fails a cast.json write (its tmp file) whose path matches, with ENOSPC; and runs
   `onCastWrite` once a cast.json tmp file is written. */
const castWrite = vi.hoisted(() => ({
  failFor: null as null | RegExp,
  onCastWrite: null as null | ((path: string) => void),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: (async (src: string, dest: string, ...rest: unknown[]) => {
      if (hook.pre) await hook.pre(String(dest));
      await (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest);
      if (hook.post) await hook.post(String(dest));
    }) as typeof actual.copyFile,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      const p = String(path);
      if (castWrite.failFor && /cast\.json\.tmp-/.test(p) && castWrite.failFor.test(p)) {
        return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      }
      await (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
      if (castWrite.onCastWrite && /cast\.json\.tmp-/.test(p)) castWrite.onCastWrite(p);
    }) as typeof actual.writeFile,
  };
});
/* Makes a synchronous copy (the walk's in-lock refresh) whose destination matches fail with EBUSY. */
const syncCopyFails = vi.hoisted(() => ({ on: null as null | RegExp }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const copyFileSync = ((src: string, dest: string, mode?: number) => {
    if (syncCopyFails.on && syncCopyFails.on.test(String(dest))) {
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
let dropStale: typeof import('../workspace/variant-base-rev.js').dropStaleVariants;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const SOLO_SERIES = 'Standalones';
const bookDir = (t: string, series = SERIES) => join(workspaceRoot, 'books', AUTHOR, series, t);
const castPath = (t: string, series = SERIES) => join(bookDir(t, series), '.audiobook', 'cast.json');
const rowOf = (t: string, series = SERIES): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t, series), 'utf8')).characters.find((c: { id: string }) => c.id === 'wren');
const file = (name: string) => join(qwenDir(), name);
const plant = (name: string, body: string) => writeFileSync(file(name), Buffer.from(body));
const read = (name: string) => readFileSync(file(name), 'utf8');

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
const persistSad = () => persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', { author: AUTHOR, series: SERIES });
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
  hook.pre = null;
  hook.post = null;
  castWrite.failFor = null;
  castWrite.onCastWrite = null;
  syncCopyFails.on = null;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('series mint: the re-key leaves foreign and already-keyed slots alone (#4037)', () => {
  it('a foreign variant name is kept', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-u_other__sad' } }));
    plantBase();
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-PT'); // a file the foreign name could be mistaken for
    await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_other__sad');
  });

  it('nothing to copy (no base .pt) copies no variant and stamps only the designing row', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    await mint();
    expect(readdirSync(qwenDir())).toEqual(['qwen-v_wren__angry.pt']);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('a row with its own uuid keeps both uuid and its legacy-named slot', async () => {
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
});

describe('series mint: a variant landing between the up-front copy and the walk (#4037)', () => {
  it('a variant first designed in the window gets its file at the new key (P1-2)', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    let fired = false;
    hook.post = async (dest) => {
      /* the up-front copy's last member: sad was not there when it listed the key */
      if (!fired && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-PT');
        plant('qwen-v_wren__sad.json', 'SAD-JSON');
        expect(await persistSad()).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-PT');
    expect(read(`qwen-${uuid}__sad.json`)).toBe('SAD-JSON');
    expect(read('qwen-v_wren__sad.pt')).toBe('SAD-PT');
  });

  it('a variant REdesigned in the window reaches the renamed slot, and stays current (P2-1, #4040)', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' }, sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plant('qwen-v_wren.json', JSON.stringify({ rev: 'r1' }));
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', JSON.stringify({ baseRev: 'r1', take: 'old' }));
    let fired = false;
    hook.post = async (dest) => {
      /* the old sad family is copied: the user's sad redesign on Book One lands, then persists */
      if (!fired && /qwen-[^\\/]+__sad\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plant('qwen-v_wren__sad.json', JSON.stringify({ baseRev: 'r1', take: 'new' }));
        expect(await persistSad()).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-NEW');
    expect(JSON.parse(read(`qwen-${uuid}__sad.json`)).take).toBe('new');
    /* the refreshed json still records the base the copied base carries: current */
    const [kept] = await dropStale([rowOf('Book One')]);
    expect(kept.overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
  });

  it('the designing row stamped outside the walk (stampOwnRow) gets the redesigned variant too', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book One', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })], { confirmed: false });
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })], { confirmed: false });
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__sad\.pt$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-NEW');
  });

  it('a landing that completes after its .pt was copied leaves no half family and no EEXIST (Q1)', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    plant('qwen-v_wren__sad.pt', 'SAD-PT'); // the landing has moved its .pt, not yet its .json
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__sad\.pt$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.json', 'SAD-JSON');
        expect(await persistSad()).toBe('applied');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-PT');
    expect(read(`qwen-${uuid}__sad.json`)).toBe('SAD-JSON');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a legacy variant absent for one step never removes the copy a stamped book names (P3-1)', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    writeBook('Book Three', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })], { confirmed: false });
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', 'SAD-OLD-J');
    let phase = 0;
    castWrite.onCastWrite = (p) => {
      if (phase === 0 && p.includes('Book One')) {
        phase = 1;
        rmSync(file('qwen-v_wren__sad.pt')); // a writer that replaces the file by rm, then rename
      } else if (phase === 1 && p.includes('Book Two')) {
        phase = 2;
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      }
    };
    const uuid = await mint();
    expect(phase).toBe(2);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-OLD');
  });

  it('a new-key variant file the mint did not write is never overwritten', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    let fired = false;
    castWrite.onCastWrite = (p) => {
      if (!fired && p.includes('Book One')) {
        fired = true;
        /* Book One, now on the new key, designs its own sad there; and another book
           still on the legacy key redesigns the legacy sad */
        const uuid = /qwen-([^\\/"]+)__sad/.exec(readFileSync(p, 'utf8'))![1];
        plant(`qwen-${uuid}__sad.pt`, 'SAD-OWN');
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-OWN');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
  });

  it('a failed refresh leaves the earlier copy whole, never a mixed family', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', 'SAD-OLD-J');
    castWrite.onCastWrite = (p) => {
      if (p.includes('Book One') && !syncCopyFails.on) {
        /* Book One is stamped; the legacy sad is redesigned before Book Two's step */
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plant('qwen-v_wren__sad.json', 'SAD-NEW-J');
        syncCopyFails.on = /__sad\.json/;
      }
    };
    await expect(mint()).rejects.toThrow(/EBUSY/);
    const uuid = rowOf('Book One').voiceUuid;
    expect(uuid).toBeTruthy();
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-OLD');
    expect(read(`qwen-${uuid}__sad.json`)).toBe('SAD-OLD-J');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a failing in-lock copy with nothing stamped removes every copy, the in-lock ones too', async () => {
    /* sad and excited land after the up-front copy; in Book One's step, sad's copy
       succeeds and excited's fails, before any row is stamped. */
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
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        for (const e of ['sad', 'excited']) {
          plant(`qwen-v_wren__${e}.pt`, `${e}-PT`);
          plant(`qwen-v_wren__${e}.json`, `${e}-JSON`);
        }
      }
    };
    syncCopyFails.on = /__excited\.json/;
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(fired).toBe(true);
    const extra = ['sad', 'excited'].flatMap((e) => [`qwen-v_wren__${e}.pt`, `qwen-v_wren__${e}.json`]);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles, ...extra].sort());
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
  });
});

describe('series mint: a failed cast write (#4062)', () => {
  it('the first book’s cast write failing after its transform leaves only the legacy files', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    castWrite.failFor = /Book One/;
    await expect(mint()).rejects.toThrow(/ENOSPC/);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
  });

  it('the designing row’s own write (stampOwnRow) failing with nothing stamped removes the copies', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book One', [withVariants({ angry: { name: 'qwen-v_wren__angry' } })], { confirmed: false });
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    castWrite.failFor = /Book Two/;
    await expect(mint()).rejects.toThrow(/ENOSPC/);
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
  });

  it('a book whose write landed keeps the copies when a later book’s write fails', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    castWrite.failFor = /Book Two/;
    await expect(mint()).rejects.toThrow(/ENOSPC/);
    const uuid = rowOf('Book One').voiceUuid;
    expect(uuid).toBeTruthy();
    expect(read(`qwen-${uuid}.pt`)).toBe('BASE-PT');
    expect(read(`qwen-${uuid}__angry.pt`)).toBe('ANGRY-PT');
  });
});

describe('book-scoped mint: a failed cast write (#4037)', () => {
  it('removes the copies and stamps nothing', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    mkdirSync(qwenDir(), { recursive: true });
    writeBook('Solo', [withVariants({ angry: { name: 'qwen-v_wren__angry' } })], { standalone: true });
    plantBase();
    plantAngry();
    castWrite.failFor = /Solo/;
    await expect(ensure(bookDir('Solo', SOLO_SERIES), 'wren')).rejects.toThrow(/ENOSPC/);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
    expect(rowOf('Solo', SOLO_SERIES).voiceUuid).toBeUndefined();
  });
});
