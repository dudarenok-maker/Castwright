/* #4037 / #4062 — the races and rollbacks of the legacy-key mint
   (ensureCharacterVoiceUuid) that its own suites (qwen-voice.series-mint-variants,
   qwen-voice.standalone-mint-variants) do not reach: a variant that lands on
   another book of the series between the mint's up-front copy and the walk's step
   for that book, a cast write that fails, and the row shapes the re-key must leave
   alone. On real cast.json files; the mint is called directly. */

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
/* Makes the refresh's synchronous rename into a matching destination fail `times` times with `code`. */
const syncRenameFails = vi.hoisted(() => ({ on: null as null | RegExp, times: 0, code: 'EPERM', calls: 0, skip: 0 }));
/* Makes a synchronous stat of a path matching `on` fail with `code` (the separated-voice record read). */
const syncStatFails = vi.hoisted(() => ({ on: null as null | RegExp, code: 'EACCES' }));
/* Sees every synchronous rename's source before it runs. */
const renameSeen = vi.hoisted(() => ({ fn: null as null | ((from: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const copyFileSync = ((src: string, dest: string, mode?: number) => {
    if (syncCopyFails.on && syncCopyFails.on.test(String(dest))) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return actual.copyFileSync(src, dest, mode);
  }) as typeof actual.copyFileSync;
  const renameSync = ((src: string, dest: string) => {
    renameSeen.fn?.(String(src));
    if (syncRenameFails.on && syncRenameFails.on.test(String(dest))) {
      syncRenameFails.calls++;
      if (syncRenameFails.skip > 0) {
        syncRenameFails.skip--; // the first `skip` matching renames succeed
      } else if (syncRenameFails.times > 0) {
        syncRenameFails.times--;
        throw Object.assign(new Error(`${syncRenameFails.code}: operation not permitted`), {
          code: syncRenameFails.code,
        });
      }
    }
    return actual.renameSync(src, dest);
  }) as typeof actual.renameSync;
  const statSync = ((path: unknown, ...rest: unknown[]) => {
    if (syncStatFails.on && syncStatFails.on.test(String(path))) {
      throw Object.assign(new Error(`${syncStatFails.code}: injected stat failure`), { code: syncStatFails.code });
    }
    return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.statSync;
  return {
    ...actual,
    default: { ...actual, copyFileSync, renameSync, statSync },
    copyFileSync,
    renameSync,
    statSync,
  };
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
  syncRenameFails.on = null;
  syncRenameFails.times = 0;
  syncRenameFails.code = 'EPERM';
  syncRenameFails.calls = 0;
  syncRenameFails.skip = 0;
  syncStatFails.on = null;
  renameSeen.fn = null;
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

  it('every stamped row names the new key once its base was copied there', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [withVariants({})]);
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
    expect(existsSync(file(`qwen-${uuid}.pt`))).toBe(true);
  });

  it('with no base copied, the stamped designing row keeps its legacy name', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book Two', [withVariants({})], { confirmed: false });
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    const uuid = await mint();
    expect(rowOf('Book Two').voiceUuid).toBe(uuid);
    expect(existsSync(file(`qwen-${uuid}.pt`))).toBe(false);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe('qwen-v_wren');
  });

  it('a library slot keeps its name, and a designing row stamped by stampOwnRow is renamed', async () => {
    seed({ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren', libraryUuid: 'lib_1' } } });
    writeBook('Book Two', [withVariants({})], { confirmed: false });
    plantBase();
    const uuid = await mint();
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.name).toBe('qwen-v_wren');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${uuid}`);
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

  it('a transient EPERM on the refresh’s rename is retried, and the refresh completes (PR #4052 pass 4)', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', 'SADJ-OLD');
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__sad\.json$/.test(dest)) {
        fired = true;
        plant('qwen-v_wren__sad.pt', 'SAD-NEW');
        plant('qwen-v_wren__sad.json', 'SADJ-NEW');
      }
    };
    syncRenameFails.on = /__sad\.pt$/;
    syncRenameFails.times = 2;
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(syncRenameFails.calls).toBe(3);
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-NEW');
    expect(read(`qwen-${uuid}__sad.json`)).toBe('SADJ-NEW');
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a legacy variant family deleted in the window changes nothing and removes nothing', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    plantBase();
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plant('qwen-v_wren__sad.json', 'SADJ-OLD');
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__sad\.json$/.test(dest)) {
        fired = true;
        rmSync(file('qwen-v_wren__sad.pt'));
        rmSync(file('qwen-v_wren__sad.json'));
      }
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-OLD');
    expect(read(`qwen-${uuid}__sad.json`)).toBe('SADJ-OLD');
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

  it('the designing row gone from its cast meanwhile (stampOwnRow writes nothing) removes the copies', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book One', [withVariants({ angry: { name: 'qwen-v_wren__angry' } })], { confirmed: false });
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        writeBook('Book Two', [], { confirmed: false }); // a merge or delete removes Wren
      }
    };
    expect(await mint()).toBeUndefined();
    expect(fired).toBe(true);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
  });

  it('the designing row separated onto its own uuid meanwhile removes the copies', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    writeBook('Book One', [withVariants({ angry: { name: 'qwen-v_wren__angry' } })], { confirmed: false });
    writeBook('Book Two', [{ ...legacy }], { confirmed: false });
    plantBase();
    plantAngry();
    let fired = false;
    hook.post = async (dest) => {
      if (!fired && /qwen-[^\\/]+__angry\.json$/.test(dest)) {
        fired = true;
        writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_sep' }], { confirmed: false }); // "Don't reuse"
      }
    };
    expect(await mint()).toBe('u_sep');
    expect(fired).toBe(true);
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

describe('a refresh of the mint copy replaces the family whole, or not at all (#4037)', () => {
  const sadSeed = () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R0' });
  };

  it('a failing .json rename after the .pt one leaves the stamped book a whole, old family', async () => {
    sadSeed();
    /* a redesign of sad lands on the legacy key right after Book One (walked first) is stamped */
    let fired = false;
    castWrite.onCastWrite = (path) => {
      if (fired || !path.includes('Book One')) return;
      fired = true;
      plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    };
    syncRenameFails.on = /qwen-[^\\/]+__sad\.json$/;
    syncRenameFails.times = 1;
    syncRenameFails.code = 'EINVAL';
    await expect(mint()).rejects.toThrow(/EINVAL/);
    expect(fired).toBe(true);
    const uuid = rowOf('Book One').voiceUuid;
    expect(uuid).toBeTruthy();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-OLD');
    expect(JSON.parse(read(`qwen-${uuid}__sad.json`)).baseRev).toBe('R0');
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
    castWrite.onCastWrite = () => {
      if (fired) return;
      fired = true;
      emotions.forEach(plantLanding);
    };
    const uuid = await mint();
    expect(fired).toBe(true);
    return uuid;
  };
  const series = { author: AUTHOR, series: SERIES };

  it('the take lands on every linked book at the new key, whole and current', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    expect(existsSync(file(`qwen-${uuid}__sad.pt`))).toBe(false); // nothing copied it: persist has not run
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    for (const t of ['Book One', 'Book Two']) {
      expect(rowOf(t).overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
      expect(await keptSlot(t, 'sad')).toBe(true);
    }
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-PT');
    expect(JSON.parse(read(`qwen-${uuid}__sad.json`)).baseRev).toBe('R1');
    expect(existsSync(file('qwen-v_wren__sad.pt'))).toBe(true);
  });

  it('a book that "Don\'t reuse" separated gets no take and no file', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
    await recordSeparatedVoice('u_sep');
    plant('qwen-u_sep.pt', 'BASE-PT'); // a real separation's copyBaseFamily leaves the byte-equal base, so only the separated check can refuse
    const cast = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    cast.characters[0] = { ...cast.characters[0], voiceUuid: 'u_sep', declinedVoiceFrom: ['b_Book Two'] };
    writeFileSync(castPath('Book One'), JSON.stringify(cast));
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(rowOf('Book One').overrideTtsVoices?.qwen?.variants?.sad).toBeUndefined();
    expect(existsSync(file('qwen-u_sep__sad.pt'))).toBe(false);
  });

  it('a current redesign replaces a current take the mint already copied to the new key', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Three', [{ ...legacy }]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'OLD-SAD-PT');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    const uuid = await mint(); // Design & compare: nothing lands, the mint copies the old sad
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('OLD-SAD-PT');
    plant('qwen-v_wren__sad.pt', 'NEW-SAD-PT'); // Book Three, confirmed later, redesigns sad on the legacy key
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    expect(await persistVariant(bookDir('Book Three'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    for (const t of ['Book One', 'Book Two', 'Book Three']) {
      expect(rowOf(t).overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    }
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('NEW-SAD-PT');
  });

  it('fails closed: a separated-voice record that cannot be read delivers no take', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    plant('qwen-u_unread.pt', 'BASE-PT'); // byte-equal base: only the separated check can refuse
    const cast = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    cast.characters[0] = { ...cast.characters[0], voiceUuid: 'u_unread' };
    writeFileSync(castPath('Book One'), JSON.stringify(cast));
    syncStatFails.on = /separated[\\/]u_unread$/; // no record exists, but the read is not ENOENT
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.sad.name).toBe(`qwen-${uuid}__sad`);
    expect(rowOf('Book One').overrideTtsVoices?.qwen?.variants?.sad).toBeUndefined();
    expect(existsSync(file('qwen-u_unread__sad.pt'))).toBe(false);
  });

  it('a follow whose .json rename fails leaves no .pt behind without its .json', async () => {
    seed(withVariants({}));
    const uuid = await mintWithLanding(['sad']);
    syncRenameFails.on = /qwen-[^\\/]+__sad\.json$/;
    syncRenameFails.times = 1;
    syncRenameFails.code = 'EINVAL';
    await expect(persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).rejects.toThrow(
      /EINVAL/,
    );
    expect(existsSync(file(`qwen-${uuid}__sad.pt`))).toBe(false);
    expect(existsSync(file(`qwen-${uuid}__sad.json`))).toBe(false);
    expect(readdirSync(qwenDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a backup whose restore failed is kept: it is the only copy of the old member', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Three', [{ ...legacy }]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'OLD-SAD-PT');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    const uuid = await mint();
    plant('qwen-v_wren__sad.pt', 'NEW-SAD-PT');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    /* the .pt rename lands, the .json one fails, and putting the .pt back fails too */
    syncRenameFails.on = /qwen-[^\\/]+__sad\.(pt|json)$/;
    syncRenameFails.skip = 1;
    syncRenameFails.times = 2;
    syncRenameFails.code = 'EINVAL';
    await expect(persistVariant(bookDir('Book Three'), 'wren', 'sad', 'qwen-v_wren__sad', series)).rejects.toThrow(
      /EINVAL/,
    );
    const baks = readdirSync(qwenDir()).filter((f) => f.startsWith(`qwen-${uuid}__sad.pt.mint-`) && f.endsWith('.tmp'));
    expect(baks).toHaveLength(1);
    expect(read(baks[0])).toBe('OLD-SAD-PT');
  });

  it('two redesigns of the legacy variant during one walk: the second refresh still lands', async () => {
    seed(withVariants({ sad: { name: 'qwen-v_wren__sad' } }));
    writeBook('Book Two', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    writeBook('Book Three', [withVariants({ sad: { name: 'qwen-v_wren__sad' } })]);
    plantBase();
    plantJson('qwen-v_wren.json', { rev: 'R1' });
    plant('qwen-v_wren__sad.pt', 'SAD-OLD');
    plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    /* a redesign lands after each of the first two stamps (a refresh in between) */
    let writes = 0;
    castWrite.onCastWrite = () => {
      writes++;
      if (writes > 2) return;
      plant('qwen-v_wren__sad.pt', `SAD-NEW-${writes}`);
      plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
    };
    const uuid = await mint();
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-NEW-2');
  });

  it('interleaved persists give every linked book every take', async () => {
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
    expect(read(`qwen-${uuid}__excited.pt`)).toBe('EXCITED-PT');
  });

  it('a standalone book follows its own mint too', async () => {
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
    expect(read(`qwen-${uuid}__sad.pt`)).toBe('SAD-PT');
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

  it('a variant family copied from an old source reads fresh to the startup sweep', async () => {
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
    castWrite.onCastWrite = (path) => {
      if (fired || !path.includes('Book One')) return;
      fired = true;
      plant('qwen-v_wren__sad.pt', 'SAD-NEW');
      plantJson('qwen-v_wren__sad.json', { baseRev: 'R1' });
      for (const f of readdirSync(qwenDir()).filter((n) => /__sad\.(pt|json)$/.test(n))) makeOld(file(f));
    };
    const seen: Array<{ from: string; ageMs: number }> = [];
    renameSeen.fn = (from) => {
      if (/\.mint-[A-Za-z0-9_-]{8}\.tmp$/.test(from)) seen.push({ from, ageMs: age(from) });
    };
    return seen;
  };

  it('a refresh stamps its temp copies fresh, whatever the age of the source', async () => {
    const seen = refreshFromOldSources();
    await mint();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.ageMs, s.from).toBeLessThan(60_000);
  });

  it('a refresh stamps its backups fresh, whatever the age of the file it replaces', async () => {
    const seen = refreshFromOldSources();
    syncRenameFails.on = /qwen-[^\\/]+__sad\.json$/; // the .json rename fails: the .pt is put back from its backup
    syncRenameFails.times = 1;
    syncRenameFails.code = 'EINVAL';
    await expect(mint()).rejects.toThrow(/EINVAL/);
    /* the .pt temp renamed over the copy, then its backup renamed back over it */
    expect(seen.filter((x) => x.from.includes('__sad.pt.mint-')).length).toBe(2);
    for (const s of seen) expect(s.ageMs, s.from).toBeLessThan(60_000);
  });
});
