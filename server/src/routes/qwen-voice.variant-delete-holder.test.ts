/* #4026 — an emotion variant's `.pt` is never deleted while a cast row still
   names it. The two routes that tear a variant down (the variant DELETE, and
   promote-voice, which drops the row's now-stale variants) only drop the row's
   own slot: they never delete a file, because a lock-free check of "does any
   other row name it" kept racing another writer adding a holder (a linked
   design, a book rename, a cast PUT's reuse hydration, the analysis series
   linker; PR #4038 review passes 1-3). The file is removed instead by a startup
   sweep (sweepOrphanVariantFiles), before the server listens, of the variant
   files no cast row in the library names: by a slot's stored `name`, by its
   uuid-derived key (`qwen-<uuid>__<emotion>`, what the render path reads) or,
   for a row with no uuid, by its legacy key (`qwen-<voiceId ?? id>__<emotion>`).

   On real cast.json files. The sidecar fetch is mocked: it writes distinct bytes
   for whatever voice it is asked for. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
const { synthesize, unlistable } = vi.hoisted(() => ({ synthesize: vi.fn(), unlistable: { dir: null as string | null } }));
/* PR #4038 pass 4 — makes ONE library folder fail to list, to pin the sweep's fail-closed branch. */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { resolve } = await import('node:path');
  return {
    ...actual,
    readdirSync: ((p: unknown, ...rest: unknown[]) => {
      if (unlistable.dir && resolve(String(p)).toLowerCase() === unlistable.dir.toLowerCase()) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readdirSync,
  };
});
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize })) };
});
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const TITLES = ['Book One', 'Book Two'] as const;
type Title = (typeof TITLES)[number];
const ANGRY = Buffer.from('BOOK-ONE-ANGRY-VARIANT');

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let previewVoiceIdFor: typeof import('./qwen-voice.js').previewVoiceIdFor;
let sweepOrphanVariantFiles: typeof import('./qwen-voice.js').sweepOrphanVariantFiles;
const ids = {} as Record<Title, string>;
let counter = 0;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const rowOf = (t: Title, id = 'wren'): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters.find((c: { id: string }) => c.id === id);
const variantsOf = (t: Title, id = 'wren') => rowOf(t, id)?.overrideTtsVoices?.qwen?.variants;
const pt = (k: string) => join(qwenDir(), `${k}.pt`);

function writeBook(t: Title, rows: Array<Record<string, unknown>>) {
  const dir = bookDir(t);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: ids[t],
      manuscriptId: `m_${ids[t]}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(t) + 1,
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
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
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
const reset = () => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
};
/* A designed row on `uuid` naming `qwen-u_shared__angry` (or another variant map). */
const designedOn = (uuid: string, variants: Record<string, unknown> = { angry: { name: 'qwen-u_shared__angry' } }) => ({
  ...legacy,
  voiceUuid: uuid,
  overrideTtsVoices: { qwen: { name: `qwen-${uuid}`, variants } },
});
/* Book One and Book Two both carry the shared variant; Two's row gets `twoExtra`. */
function seedShared(twoExtra: Record<string, unknown> = {}, oneRow: Record<string, unknown> = designedOn('u_shared')) {
  reset();
  writeBook('Book One', [oneRow]);
  writeBook('Book Two', [{ ...designedOn('u_shared'), ...twoExtra }]);
  writeFileSync(pt('qwen-u_shared'), Buffer.from('BOOK-ONE-BASE'));
  writeFileSync(pt('qwen-u_shared__angry'), ANGRY);
}
const kept = () => existsSync(pt('qwen-u_shared__angry')) && readFileSync(pt('qwen-u_shared__angry')).equals(ANGRY);

const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const decline = (t: Title, from: Title) =>
  request(app).post(`/api/books/${ids[t]}/cast/wren/decline-voice-link`).send({ fromBookId: ids[from] });
const del = (t: Title, emotion = 'angry', charId = 'wren') =>
  request(app).delete(`/api/books/${ids[t]}/cast/${charId}/emotion-variant/${emotion}`);
const promote = (t: Title, uuid: string) => {
  const previewId = previewVoiceIdFor(`qwen-${uuid}`, ids[t], 'wren');
  writeFileSync(pt(previewId), Buffer.from('PREVIEW'));
  return request(app)
    .post(`/api/books/${ids[t]}/cast/wren/promote-voice`)
    .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
};

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-variant-holder-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-variant-holder-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  ({ previewVoiceIdFor } = await import('./qwen-voice.js'));
  ({ sweepOrphanVariantFiles } = await import('./qwen-voice.js'));
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
  const { bookStateRouter } = await import('./book-state.js');
  app.use('/api/books', bookStateRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not JSON */
    }
    if (voiceId && String(url).includes('/qwen/') && !String(url).includes('evict')) {
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from(`DESIGN-${++counter}`));
    }
    const bytes = new Uint8Array(24_000 * 2 * 0.3);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
      arrayBuffer: async () => bytes.buffer,
      json: async () => ({}),
    };
  });
  synthesize.mockReset();
  vi.mocked(withCapacityRetry).mockReset();
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

describe('#4026 — the issue repro, on the ordinary routes', () => {
  it("design One, design One's angry, Don't reuse on Two, remove Two's angry: One's angry file and slot survive", async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [
      { ...legacy, matchedFrom: { bookId: ids['Book One'], characterId: 'wren', bookTitle: 'Book One', confidence: 1 } },
    ]);
    const base = await design('Book One');
    expect(base.status, JSON.stringify(base.body)).toBe(200);
    const angry = await design('Book One', { emotion: 'angry' });
    expect(angry.status, JSON.stringify(angry.body)).toBe(200);
    const oneAngry = variantsOf('Book One')?.angry?.name as string;
    expect(oneAngry).toBeTruthy();
    const before = readFileSync(pt(oneAngry));
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const res = await del('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')?.angry).toBeUndefined();
    expect(variantsOf('Book One')?.angry?.name).toBe(oneAngry);
    expect(existsSync(pt(oneAngry)), "Book One's angry variant file was deleted").toBe(true);
    expect(readFileSync(pt(oneAngry)).equals(before)).toBe(true);
  });
});

describe('#4026 — variant DELETE drops only its own slot, never a file', () => {
  it('an unforked declined row (a decline recorded before "Don\'t reuse" separated rows): One keeps its file and slot', async () => {
    seedShared({ declinedVoiceFrom: [ids['Book One']] });
    const res = await del('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_shared__angry');
    expect(kept(), "Book One's angry variant file was deleted").toBe(true);
  });

  it('a still-linked book still names it: kept', async () => {
    seedShared();
    expect((await del('Book Two')).status).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')?.angry).toBeDefined();
    expect(kept()).toBe(true);
  });

  it('the sole owner: the slot goes, the file stays (the startup sweep removes it), and no sidecar call is made', async () => {
    seedShared();
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_one' }] }));
    writeFileSync(join(qwenDir(), 'qwen-u_shared__angry.json'), '{}');
    const res = await del('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(kept(), 'the DELETE deleted a variant file').toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-u_shared__angry.json'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('#4026 — promote drops the row\'s stale variant slots, never their files', () => {
  it("an unforked declined row (a pre-#4007 decline): Two's preview is staged through design-voice, which separates it; One keeps its base, file and slot", async () => {
    seedShared({ declinedVoiceFrom: [ids['Book One']] });
    /* Through the real routes: the design separates Two before it stages, so the
       preview id carries Two's new key and promote follows it. */
    const staged = await design('Book Two', { preview: true });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const res = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: staged.body.voiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rowOf('Book Two').voiceUuid, 'Two was separated from One').not.toBe('u_shared');
    expect(rowOf('Book One').voiceUuid).toBe('u_shared');
    expect(readFileSync(pt('qwen-u_shared')).toString(), "Book One's base was overwritten").toBe('BOOK-ONE-BASE');
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_shared__angry');
    expect(kept(), "Book One's angry variant file was deleted").toBe(true);
  });

  it('a still-linked book: #4040 resets the variants of One with those of Two, and the variant file is kept', async () => {
    seedShared();
    const res = await promote('Book Two', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')).toBeUndefined();
    expect(kept()).toBe(true);
  });

  it('the sole owner: the slots go, the file stays (the startup sweep removes it)', async () => {
    seedShared();
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_one' }] }));
    const res = await promote('Book Two', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(kept(), 'promote deleted a variant file').toBe(true);
  });
});

/* The variant file family a design lands (`.pt`, persona `.json`, reference
   clip, derived 1.7B prompt). */
const family = (k: string) => [`${k}.pt`, `${k}.json`, `${k}__master.wav`, `${k}__1.7b.pt`];
const HOUR_AGO = new Date(Date.now() - 61 * 60_000);
function plant(names: string[], old = true) {
  for (const n of names) {
    writeFileSync(join(qwenDir(), n), 'x');
    if (old) utimesSync(join(qwenDir(), n), HOUR_AGO, HOUR_AGO);
  }
}
const onDisk = () => readdirSync(qwenDir()).sort();
const slot = (name: string, variants: Record<string, unknown>) => ({ overrideTtsVoices: { qwen: { name, variants } } });

describe('#4026 — the startup sweep of variant files no cast row names', () => {
  it('deletes an unnamed variant family and keeps one each naming form still names', async () => {
    reset();
    writeBook('Book One', [
      /* stored name (a name that is not this row's own key) */
      { ...legacy, voiceUuid: 'u_one', ...slot('qwen-u_one', { angry: { name: 'qwen-u_elsewhere__angry' } }) },
      /* uuid-derived key: the slot is present under another stored name */
      { ...legacy, id: 'kit', voiceId: 'v_kit', voiceUuid: 'u_kit', ...slot('qwen-u_kit', { sad: { name: 'other' } }) },
    ]);
    writeBook('Book Two', [
      /* legacy row (no uuid): its legacy key `qwen-<voiceId>__<emotion>` */
      { ...legacy, ...slot('qwen-v_wren', { whisper: { name: 'other2' } }) },
      /* a uuid row never reads its legacy key: no holder of qwen-v_ash__excited */
      { ...legacy, id: 'ash', voiceId: 'v_ash', voiceUuid: 'u_ash', ...slot('qwen-u_ash', { excited: { name: 'qwen-u_ash__excited' } }) },
    ]);
    const named = ['qwen-u_elsewhere__angry', 'qwen-u_kit__sad', 'qwen-v_wren__whisper', 'qwen-u_ash__excited'];
    const unnamed = ['qwen-u_gone__angry', 'qwen-v_ash__excited', 'qwen-u_kit__angry'];
    plant([...named.flatMap(family), ...unnamed.flatMap(family)]);
    expect(await sweepOrphanVariantFiles()).toBe(unnamed.length * 4);
    expect(onDisk()).toEqual(named.flatMap(family).sort());
  });

  it('fails closed: one unreadable cast.json and nothing is deleted, logged once', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_two' }]);
    writeFileSync(castPath('Book Two'), '{"characters":[');
    plant(family('qwen-u_gone__angry'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await sweepOrphanVariantFiles()).toBe(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('[variant-sweep]'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(onDisk()).toEqual(family('qwen-u_gone__angry').sort());
  });

  /* PR #4038 pass 4 — a reparse deletes cast.json after copying its voice slots to
     cast-reuse-carryover.json, which the next analysis restores. Until it does, the
     carryover is the only thing naming the book's variants. */
  it('a reparsed book (cast.json gone, slots in cast-reuse-carryover.json) still names its variants', async () => {
    reset();
    writeBook('Book One', [designedOn('u_solo')]);
    plant([...family('qwen-u_solo'), ...family('qwen-u_shared__angry'), ...family('qwen-u_gone__angry')]);
    const res = await request(app).post(`/api/books/${ids['Book One']}/reparse`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(existsSync(castPath('Book One'))).toBe(false);
    expect(existsSync(join(bookDir('Book One'), '.audiobook', 'cast-reuse-carryover.json'))).toBe(true);
    expect(await sweepOrphanVariantFiles()).toBe(4);
    expect(onDisk()).toEqual([...family('qwen-u_solo'), ...family('qwen-u_shared__angry')].sort());
  });

  it('fails closed when the carryover exists but cannot be read: nothing is deleted', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    rmSync(castPath('Book One'));
    writeFileSync(join(bookDir('Book One'), '.audiobook', 'cast-reuse-carryover.json'), '{"characters":[');
    plant(family('qwen-u_gone__angry'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await sweepOrphanVariantFiles()).toBe(0);
    } finally {
      warn.mockRestore();
    }
    expect(onDisk()).toEqual(family('qwen-u_gone__angry').sort());
  });

  it('a non-empty cast.json decides alone: a stale carryover beside it names nothing', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    writeFileSync(
      join(bookDir('Book One'), '.audiobook', 'cast-reuse-carryover.json'),
      JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', voiceUuid: 'u_old', ...slot('qwen-u_old', { angry: { name: 'qwen-u_old__angry' } }) }] }),
    );
    plant(family('qwen-u_old__angry'));
    expect(await sweepOrphanVariantFiles()).toBe(4);
  });

  it('an empty cast.json (characters: []) falls through to the carryover: a variant it names is kept', async () => {
    reset();
    writeBook('Book One', []);
    writeFileSync(
      join(bookDir('Book One'), '.audiobook', 'cast-reuse-carryover.json'),
      JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', voiceUuid: 'u_x', ...slot('qwen-u_x', { angry: { name: 'qwen-u_x__angry' } }) }] }),
    );
    plant(family('qwen-u_x__angry'));
    expect(await sweepOrphanVariantFiles()).toBe(0);
    expect(onDisk()).toEqual(family('qwen-u_x__angry').sort());
  });

  it('fails closed when a library folder cannot be listed: nothing is deleted', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    plant(family('qwen-u_gone__angry'));
    unlistable.dir = resolve(workspaceRoot, 'books', AUTHOR, SERIES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await sweepOrphanVariantFiles()).toBe(0);
    } finally {
      unlistable.dir = null;
      warn.mockRestore();
    }
    expect(onDisk()).toEqual(family('qwen-u_gone__angry').sort());
  });

  it('keeps an unnamed variant file younger than an hour (a second server may be mid-design)', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    plant(['qwen-u_fresh__angry.pt'], false);
    plant(['qwen-u_old__angry.pt']);
    expect(await sweepOrphanVariantFiles()).toBe(1);
    expect(onDisk()).toEqual(['qwen-u_fresh__angry.pt']);
  });

  it('never touches a base voice, a preview, a staging file or a base whose key ends like a variant', async () => {
    reset();
    /* a character whose own id ends in `__angry`: its base key looks like a variant */
    writeBook('Book One', [{ ...legacy, id: 'odd__angry', voiceId: undefined, ...slot('qwen-odd__angry', {}) }]);
    const untouched = [
      ...family('qwen-u_orphan_base'), // an unnamed base: not this sweep's business
      ...family('qwen-odd__angry'), // a named base shaped like a variant
      'qwen-u_x__angry-preview-abc123.pt', // a staged compare preview
      'qwen-u_x__angry-preview-abc123.json',
      'qwen-staging-AbCdEfGhIjKlMn__angry.pt', // a staging key whose nanoid ends in `__angry`
      'qwen-staging-AbCdEfGhIjKlMn__angry__master.wav',
      'notes.txt',
    ];
    plant(untouched);
    expect(await sweepOrphanVariantFiles()).toBe(0);
    expect(onDisk()).toEqual([...untouched].sort());
  });

  it('index.ts awaits it before the server starts listening', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    const sweep = src.indexOf('await sweepOrphanVariantFiles()');
    const listen = src.indexOf('listenWithAutoRebind(server');
    expect(sweep).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(listen);
    expect(src).not.toMatch(/void\s+sweepOrphanVariantFiles/);
  });
});
