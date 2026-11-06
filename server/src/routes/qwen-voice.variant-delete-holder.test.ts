/* #4026 — an emotion variant's `.pt` is never deleted while another cast row
   still names it, whether that row is a linked book, a book that declined (or was
   declined by) this one, or a same-book sibling, and whatever it names it by: the
   stored variant `name`, its uuid-derived key (`qwen-<uuid>__<emotion>`, what the
   render path reads) or, for a row with no uuid, its legacy key (`qwen-<voiceId ?? id>__<emotion>`).

   The two routes that delete a variant file, on real cast.json files: the
   variant DELETE and promote-voice (which drops the row's now-stale variants).
   Both drop the slot from THIS row first, then tear the file down unless a row
   still names it. The sidecar fetch is mocked: it writes distinct bytes for
   whatever voice it is asked for. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
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
/* Holds persistEmotionVariant's series walk (its fresh clone re-check, the only
   2-argument call; the route's own pre-GPU check passes 4) between a variant's
   landing and the slot writes, so a DELETE can run in that span. */
const walkGate = vi.hoisted(() => ({
  armed: false,
  entered: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock('./voices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voices.js')>();
  return {
    ...actual,
    hasClonedSlotAmongMatches: async (...args: Parameters<typeof actual.hasClonedSlotAmongMatches>) => {
      if (walkGate.armed && args.length <= 2) {
        walkGate.armed = false;
        walkGate.entered?.();
        await walkGate.release;
      }
      return actual.hasClonedSlotAmongMatches(...args);
    },
  };
});

/* Pauses the variant teardown's holder scan on the Nth read of one cast.json,
   either just before or just after the read, so a test can change the library
   mid-scan. */
const scanGate = vi.hoisted(() => ({
  path: null as null | string,
  nth: 1,
  seen: 0,
  when: 'after' as 'before' | 'after',
  entered: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  const { resolve: res } = await import('node:path');
  const hit = (p: string) => !!scanGate.path && res(p) === scanGate.path && ++scanGate.seen === scanGate.nth;
  return {
    ...actual,
    readJson: async (p: string) => {
      if (scanGate.when === 'before' && hit(p)) {
        scanGate.path = null;
        scanGate.entered?.();
        await scanGate.release;
      }
      const v = await actual.readJson(p);
      if (scanGate.when === 'after' && hit(p)) {
        scanGate.path = null;
        scanGate.entered?.();
        await scanGate.release;
      }
      return v;
    },
  };
});

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
let resetSavingKeysForTests: typeof import('./qwen-voice.js').resetSavingKeysForTests;
let withBookOp: typeof import('../workspace/book-op-lock.js').withBookOp;
let moveBookFolder: typeof import('../workspace/book-op-lock.js').moveBookFolder;
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
  scanGate.path = null;
  scanGate.seen = 0;
  walkGate.armed = false;
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
  ({ resetSavingKeysForTests } = await import('./qwen-voice.js'));
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { castDesignRouter } = await import('./cast-design.js');
  const { makeBookId } = await import('../workspace/paths.js');
  ({ withBookOp, moveBookFolder } = await import('../workspace/book-op-lock.js'));
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/books', castDesignRouter);
});

beforeEach(() => {
  resetSavingKeysForTests();
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

describe('#4026 — variant DELETE keeps a file another row still names', () => {
  it('an unforked declined row (a decline recorded before "Don\'t reuse" separated rows): One keeps its file', async () => {
    seedShared({ declinedVoiceFrom: [ids['Book One']] });
    const res = await del('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_shared__angry');
    expect(kept(), "Book One's angry variant file was deleted").toBe(true);
  });

  it('the declined book itself (One declined Two) still names it: kept', async () => {
    seedShared({}, { ...designedOn('u_shared'), declinedVoiceFrom: [ids['Book Two']] });
    expect((await del('Book Two')).status).toBe(200);
    expect(kept()).toBe(true);
  });

  it('a still-linked book (no marker anywhere) still names it: kept', async () => {
    seedShared();
    expect((await del('Book Two')).status).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')?.angry).toBeDefined();
    expect(kept()).toBe(true);
  });

  it('a holder that names it only by its uuid-derived key (slot with another stored name): kept', async () => {
    seedShared({}, designedOn('u_shared', { angry: { name: 'something-else' } }));
    expect((await del('Book Two')).status).toBe(200);
    expect(kept()).toBe(true);
  });

  it('a holder that names it only by its legacy key (a row with no uuid, voiceId v_wren): kept', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'other' } } } } }]);
    writeBook('Book Two', [designedOn('u_shared', { angry: { name: 'qwen-v_wren__angry' } })]);
    writeFileSync(pt('qwen-v_wren__angry'), ANGRY);
    expect((await del('Book Two')).status).toBe(200);
    expect(readFileSync(pt('qwen-v_wren__angry')).equals(ANGRY)).toBe(true);
  });

  it("a uuid row's legacy-looking key is no holder: deleting a uuid row's angry leaves no orphan behind", async () => {
    /* Book X's legacy narrator (no uuid) names qwen-narrator__angry; an unrelated
       book's narrator is on a uuid and renders qwen-<uuid>__angry. The uuid row
       never reads the legacy key, so it must not be what keeps it (nor strand it
       once X lets go). */
    reset();
    const narrator = { id: 'narrator', name: 'Narrator', role: 'narrator' };
    writeBook('Book One', [
      { ...narrator, voiceUuid: 'u_y', overrideTtsVoices: { qwen: { name: 'qwen-u_y', variants: { angry: { name: 'qwen-u_y__angry' } } } } },
    ]);
    writeBook('Book Two', [
      { ...narrator, overrideTtsVoices: { qwen: { name: 'qwen-narrator', variants: { angry: { name: 'qwen-narrator__angry' } } } } },
    ]);
    writeFileSync(pt('qwen-u_y__angry'), Buffer.from('Y-ANGRY'));
    writeFileSync(pt('qwen-narrator__angry'), Buffer.from('X-ANGRY'));
    /* the legacy row's own delete is the last holder of its file, and the uuid row
       does not hold it */
    expect((await del('Book Two', 'angry', 'narrator')).status).toBe(200);
    expect(existsSync(pt('qwen-narrator__angry'))).toBe(false);
    expect((await del('Book One', 'angry', 'narrator')).status).toBe(200);
    expect(existsSync(pt('qwen-u_y__angry'))).toBe(false);
  });

  it('a same-book sibling on the same key that names it: kept', async () => {
    seedShared();
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_one' }] }));
    writeFileSync(
      castPath('Book Two'),
      JSON.stringify({ characters: [designedOn('u_shared'), { ...designedOn('u_shared'), id: 'wren-young' }] }),
    );
    expect((await del('Book Two')).status).toBe(200);
    expect(variantsOf('Book Two', 'wren-young')?.angry).toBeDefined();
    expect(kept()).toBe(true);
  });

  it('control: no other row names it, so it is deleted as before', async () => {
    seedShared();
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_one' }] }));
    expect((await del('Book Two')).status).toBe(200);
    expect(kept()).toBe(false);
  });
});

describe('#4026 — the holder check against a linked variant design in flight', () => {
  it("a DELETE while a linked book's design has landed but not yet written its slot keeps the file; both books render it", async () => {
    /* Two names the angry variant, One has no angry slot (a divergence the series
       walk's unconfirmed-cast skip can leave). One re-designs angry. */
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_shared', overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } } }]);
    writeBook('Book Two', [designedOn('u_shared')]);
    writeFileSync(pt('qwen-u_shared'), Buffer.from('BOOK-ONE-BASE'));
    writeFileSync(pt('qwen-u_shared__angry'), ANGRY);
    let release!: () => void;
    walkGate.release = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (walkGate.entered = r));
    walkGate.armed = true;
    const designing = design('Book One', { emotion: 'angry' }).then((r) => r);
    await entered; // landed (the file now holds One's new bytes); no slot written yet
    const landed = readFileSync(pt('qwen-u_shared__angry'));
    expect(landed.equals(ANGRY)).toBe(false);
    const res = await del('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    release();
    const done = await designing;
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_shared__angry');
    expect(variantsOf('Book Two')?.angry?.name).toBe('qwen-u_shared__angry');
    expect(existsSync(pt('qwen-u_shared__angry')), 'the just-designed variant file was deleted').toBe(true);
    expect(readFileSync(pt('qwen-u_shared__angry')).equals(landed)).toBe(true);
  });
});

/* Resolves `entered` when the gated call is reached; holds it until `release()`. */
function gate(g: typeof scanGate | typeof walkGate) {
  let release!: () => void;
  g.release = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (g.entered = r));
  return { entered, release };
}

describe('#4026 — a holder book renamed while the teardown scans', () => {
  it('a folder moved after the scan listed it is not invisible: the file its renamed cast still names is kept', async () => {
    seedShared({}, designedOn('u_shared')); // One ALSO names it: a still-linked holder
    scanGate.path = resolve(castPath('Book One'));
    scanGate.nth = 1;
    scanGate.seen = 0;
    scanGate.when = 'before';
    const g = gate(scanGate);
    const deleting = del('Book Two').then((r) => r);
    const newDir = bookDir('Book One Renamed');
    try {
      await g.entered; // the scan listed "Book One" and is about to read its cast.json
      await withBookOp(ids['Book One'], (b) =>
        moveBookFolder(b, newDir, (s) => ({ ...s, title: 'Book One Renamed' })),
      );
    } finally {
      g.release();
    }
    expect((await deleting).status).toBe(200);
    const renamed = JSON.parse(readFileSync(join(newDir, '.audiobook', 'cast.json'), 'utf8')).characters[0];
    expect(renamed.overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-u_shared__angry');
    expect(kept(), 'deleted a variant file the renamed book still names').toBe(true);
  });
});

/* Two legacy (no-uuid) narrators in different series, both rendering
   `qwen-narrator__angry`. X (Other Author) names the slot and is deleted; Y (the
   test series, no angry slot yet) designs angry. Y's design needs none of X's
   book-ops, so it can land and finish while X's teardown is scanning. The scan
   reads Y's folder first, so a gate on X's cast.json lands after Y was read. */
const X_AUTHOR = 'Other Author';
const X_SERIES = 'Other Series';
const X_TITLE = 'Book X';
let xBookId: string;
const xDir = () => join(workspaceRoot, 'books', X_AUTHOR, X_SERIES, X_TITLE);
const xCast = () => join(xDir(), '.audiobook', 'cast.json');
const narr = { id: 'narrator', name: 'Narrator', role: 'narrator', voiceStyle: 'a calm narrator', evidence: [{ quote: '"So."' }], gender: 'male', ageRange: 'adult' };
function seedCrossSeries() {
  reset();
  writeBook('Book One', [{ ...narr, overrideTtsVoices: { qwen: { name: 'qwen-narrator' } } }]); // Y
  mkdirSync(join(xDir(), '.audiobook'), { recursive: true });
  writeFileSync(
    join(xDir(), '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: xBookId, manuscriptId: 'm_x', title: X_TITLE, author: X_AUTHOR, series: X_SERIES,
      seriesPosition: 1, isStandalone: false, manuscriptFile: 'manuscript.txt', castConfirmed: true,
      chapters: [], language: 'en', coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(xDir(), 'manuscript.txt'), 'placeholder');
  writeFileSync(
    xCast(),
    JSON.stringify({ characters: [{ ...narr, overrideTtsVoices: { qwen: { name: 'qwen-narrator', variants: { angry: { name: 'qwen-narrator__angry' } } } } }] }),
  );
  writeFileSync(pt('qwen-narrator'), Buffer.from('BASE'));
  writeFileSync(pt('qwen-narrator__angry'), Buffer.from('OLD-ANGRY'));
}
const designY = () =>
  request(app).post(`/api/books/${ids['Book One']}/cast/narrator/design-voice`).send({ sampleVoiceId: 'v_n', modelKey: QWEN_KEY, emotion: 'angry' });
const deleteX = () => request(app).delete(`/api/books/${xBookId}/cast/narrator/emotion-variant/angry`);
const yAngry = () => rowOf('Book One', 'narrator')?.overrideTtsVoices?.qwen?.variants?.angry?.name;
const pauseScanAfterReadingX = () => {
  scanGate.path = resolve(xCast());
  scanGate.nth = 2; // the first read is the teardown's own pre-scan read of X
  scanGate.seen = 0;
  scanGate.when = 'after';
  return gate(scanGate);
};

describe('#4026 — the teardown\'s before/during/after check against a design in another series', () => {
  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    xBookId = makeBookId(X_AUTHOR, X_SERIES, X_TITLE);
  });

  it('a whole design that lands and writes its slot during the scan (begun moved, nothing active at either end): kept', async () => {
    seedCrossSeries();
    const scan = pauseScanAfterReadingX();
    const deleting = deleteX().then((r) => r);
    try {
      await scan.entered; // the scan has read Y (no angry slot) and X (dropped)
      const r = await designY();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally {
      scan.release();
    }
    expect((await deleting).status).toBe(200);
    expect(yAngry()).toBe('qwen-narrator__angry');
    expect(existsSync(pt('qwen-narrator__angry')), 'deleted a file Y names').toBe(true);
  });

  it('a hold already active when the teardown starts and released during its scan (active at the start only): kept', async () => {
    seedCrossSeries();
    walkGate.armed = true;
    const walk = gate(walkGate);
    const designing = designY().then((r) => r);
    await walk.entered; // landed, holding
    const scan = pauseScanAfterReadingX();
    const deleting = deleteX().then((r) => r);
    try {
      /* With the start-of-teardown check the DELETE answers without scanning at
         all; without it the scan runs and parks here while the hold is released. */
      await Promise.race([scan.entered, deleting]);
      walk.release();
      const r = await designing;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally {
      walk.release();
      scan.release();
    }
    expect((await deleting).status).toBe(200);
    expect(yAngry()).toBe('qwen-narrator__angry');
    expect(existsSync(pt('qwen-narrator__angry')), 'deleted a file Y names').toBe(true);
  });
});

describe('#4026 — the bulk job (Design full cast → Emotion variants) holds its landed variant', () => {
  const bulk = () =>
    request(app)
      .post(`/api/books/${ids['Book One']}/cast/design`)
      .send({ modelKey: QWEN_KEY, scope: 'variants', characterIds: [], variantTasks: [{ characterId: 'wren', emotions: ['angry'] }] });
  /* One has no angry slot, Two names it: the bulk job designs One's. */
  const seedBulk = () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_bulk', overrideTtsVoices: { qwen: { name: 'qwen-u_bulk' } } }]);
    writeBook('Book Two', [designedOn('u_bulk', { angry: { name: 'qwen-u_bulk__angry' } })]);
    writeFileSync(pt('qwen-u_bulk'), Buffer.from('BASE'));
    writeFileSync(pt('qwen-u_bulk__angry'), ANGRY);
  };

  it('a DELETE between the job\'s landing and its slot write keeps the file (the landing is held)', async () => {
    seedBulk();
    walkGate.armed = true;
    const walk = gate(walkGate);
    const job = bulk().then((r) => r);
    await walk.entered; // landed, slot not written
    const landed = readFileSync(pt('qwen-u_bulk__angry'));
    expect(landed.equals(ANGRY)).toBe(false);
    expect((await del('Book Two')).status).toBe(200);
    walk.release();
    const done = await job;
    expect(done.status, done.text).toBe(200);
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_bulk__angry');
    expect(readFileSync(pt('qwen-u_bulk__angry')).equals(landed), 'the just-designed variant file was deleted').toBe(true);
  });

  it('the hold is released when the job writes the slot: the next sole-owner DELETE deletes the file', async () => {
    seedBulk();
    const done = await bulk();
    expect(done.status, done.text).toBe(200);
    expect(variantsOf('Book One')?.angry?.name).toBe('qwen-u_bulk__angry');
    expect((await del('Book Two')).status).toBe(200); // One still names it
    expect(existsSync(pt('qwen-u_bulk__angry'))).toBe(true);
    expect((await del('Book One')).status).toBe(200); // the last holder
    expect(existsSync(pt('qwen-u_bulk__angry')), 'hold leaked: the file outlived its last holder').toBe(false);
  });
});

describe('#4026 — promote keeps a stale variant file another row still names', () => {
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

  it('a still-linked book: One still names it, so it is kept', async () => {
    seedShared();
    const res = await promote('Book Two', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(variantsOf('Book Two')).toBeUndefined();
    expect(variantsOf('Book One')?.angry).toBeDefined();
    expect(kept()).toBe(true);
  });

  it('control: no other row names it, so promote tears it down as before', async () => {
    seedShared();
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [{ ...legacy, voiceUuid: 'u_one' }] }));
    const res = await promote('Book Two', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(kept()).toBe(false);
  });
});
