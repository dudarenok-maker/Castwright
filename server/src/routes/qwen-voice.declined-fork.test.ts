/* #3992 — redesigning a character whose series link the user DECLINED must
   give it its own voiceUuid (the earlier book's `qwen-<uuid>.pt` stays
   untouched); a character whose link is still active keeps sharing.

   Two real books in one series; Book One's row and Book Two's row share
   `voiceId` + `voiceUuid: 'u_shared'`. The sidecar fetch is mocked: it records
   the voiceId it is asked for and writes that `.pt` with DIFFERENT bytes, so a
   missing fork shows up as Book One's bytes being overwritten. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
/* Fails the copy of one source file with a non-ENOENT error (an EBUSY from a
   scanner holding the file), to prove a failed copy is not read as "absent". */
const failCopyOf = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const copyFile = async (src: unknown, dest: unknown, mode?: number) => {
    if (failCopyOf.suffix && String(src).endsWith(failCopyOf.suffix)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${String(src)}'`), {
        code: 'EBUSY',
        syscall: 'copyfile',
        path: String(src),
      });
    }
    return actual.copyFile(src as string, dest as string, mode);
  };
  return { ...actual, default: { ...actual, copyFile }, copyFile };
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
const ORIG_PT = Buffer.from('BOOK-ONE-ORIGINAL-PT');
const ORIG_JSON = Buffer.from('{"voiceId":"qwen-u_shared","instruct":"book one"}');
const NEW_PT = Buffer.from('REDESIGNED-BY-SIDECAR');

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let requestedVoiceIds: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRow = (title: string): Record<string, unknown> =>
  JSON.parse(readFileSync(castPath(title), 'utf8')).characters[0];

function writeBook(title: string, position: number, id: string, row: Record<string, unknown>) {
  const dir = bookDir(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: position,
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
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [row] }),
  );
}

const baseRow = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceUuid: 'u_shared',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
};

function seed(bookTwoExtra: Record<string, unknown>) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', 1, bookOneId, { ...baseRow });
  writeBook('Book Two', 2, bookTwoId, { ...baseRow, ...bookTwoExtra });
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
  writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
}

function pcm() {
  return new Uint8Array(24_000 * 2 * 0.3);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-fork-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-fork-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { voicesRouter } = await import('./voices.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/voices', voicesRouter);
});

beforeEach(() => {
  failCopyOf.suffix = null;
  requestedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not a design call */
    }
    if (voiceId) {
      requestedVoiceIds.push(voiceId);
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT);
      writeFileSync(join(qwenDir(), `${voiceId}.json`), JSON.stringify({ instruct: 'book two persona' }));
    }
    const bytes = pcm();
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

const design = (id: () => string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${id()}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

describe('#3992 — declined series link forks the shared voiceUuid on a base design', () => {
  it('Declined: Book Two gets its own uuid; Book One’s files stay byte-identical', async () => {
    seed({});
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);

    expect(requestedVoiceIds).toHaveLength(1);
    const m = /^qwen-(.+)$/.exec(requestedVoiceIds[0]);
    expect(m).not.toBeNull();
    const fresh = m![1];
    expect(fresh).not.toBe('u_shared');

    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(existsSync(join(qwenDir(), `qwen-${fresh}.pt`))).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.json')).equals(ORIG_JSON)).toBe(true);
    /* the sidecar overwrote only the forked copy */
    expect(readFileSync(join(qwenDir(), `qwen-${fresh}.pt`)).equals(NEW_PT)).toBe(true);
  });

  it('Declined + preview: discard leaves Book Two on U’ holding Book One’s original bytes', async () => {
    seed({});
    const res = await design(() => bookTwoId, { preview: true });
    expect(res.status).toBe(200);

    const previewId = requestedVoiceIds[0];
    expect(previewId).toMatch(/^qwen-.+-preview$/);
    const fresh = previewId.replace(/^qwen-/, '').replace(/-preview$/, '');
    expect(fresh).not.toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe(fresh);

    const discard = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/discard-voice`)
      .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(discard.status).toBe(200);

    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readFileSync(join(qwenDir(), `qwen-${fresh}.pt`)).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.json')).equals(ORIG_JSON)).toBe(true);
  });

  it('Linked: a design for Book Two goes to qwen-u_shared, no new uuid, no copy', async () => {
    seed({});
    /* matchedFrom names the real Book One */
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(qwenDir()).filter((f) => f.endsWith('.pt'))).toEqual(['qwen-u_shared.pt']);
  });

  it('Source of a live link: designing Book One’s row shares qwen-u_shared, no fork', async () => {
    seed({});
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    const res = await design(() => bookOneId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });

  it('Assign: a bookId-less matchedFrom counts as an active link — no fork', async () => {
    seed({ matchedFrom: { bookTitle: 'Book One', confidence: 0.92 } });
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });
});

describe('#3992 — emotion variants stay off the earlier book', () => {
  const VAR_BYTES = Buffer.from('BOOK-ONE-ANGRY-VARIANT');
  const slot = (title: string, key: string) => {
    const q = (readRow(title).overrideTtsVoices as { qwen?: { variants?: Record<string, { name: string }> } } | undefined)?.qwen;
    return q?.variants?.[key]?.name;
  };
  const seedVariant = (bookTwoExtra: Record<string, unknown>) => {
    seed(bookTwoExtra);
    writeFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt'), VAR_BYTES);
  };

  it('Declined variant: Book Two forks; Book One’s variant file and row are untouched', async () => {
    seedVariant({});
    const res = await design(() => bookTwoId, { emotion: 'angry' });
    expect(res.status).toBe(200);

    expect(requestedVoiceIds).toHaveLength(1);
    const m = /^qwen-(.+)__angry$/.exec(requestedVoiceIds[0]);
    expect(m).not.toBeNull();
    const fresh = m![1];
    expect(fresh).not.toBe('u_shared');

    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt')).equals(VAR_BYTES)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
    expect(slot('Book One', 'angry')).toBeUndefined();
    expect(slot('Book Two', 'angry')).toBe(`qwen-${fresh}__angry`);
  });

  it('Linked variant: sidecar asked for qwen-u_shared__angry; both rows carry the slot', async () => {
    seedVariant({});
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    const res = await design(() => bookTwoId, { emotion: 'angry' });
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared__angry']);
    expect(slot('Book One', 'angry')).toBe('qwen-u_shared__angry');
    expect(slot('Book Two', 'angry')).toBe('qwen-u_shared__angry');
  });

  it('No uuid: a variant design mints nothing', async () => {
    seedVariant({});
    const row = { ...readRow('Book Two') };
    delete row.voiceUuid;
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    await design(() => bookTwoId, { emotion: 'angry' });
    expect(readRow('Book Two').voiceUuid).toBeUndefined();
    expect(requestedVoiceIds).toEqual(['qwen-v_wren__angry']);
  });
});

/* Review pass 1, finding 1 — render never reads the stored variant name:
   `pickEmotionVariantVoice` re-derives `<base>__<emotion>` from the row's uuid,
   and a fork copies only the base family. A variants map that survives a fork
   therefore asks for a `.pt` that does not exist (`voice_not_designed`). */
describe('#3992 — a fork leaves no variant the render path cannot resolve', () => {
  const voiced = {
    ttsEngine: 'qwen',
    overrideTtsVoices: {
      qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } },
    },
  };
  const seedVoiced = () => {
    seed({ ...voiced });
    writeFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt'), Buffer.from('BOOK-ONE-ANGRY'));
  };
  /* the key synthesis asks the sidecar for, per emotion */
  const renderKey = async (title: string, emotion: string) => {
    const pick = await import('../tts/voice-mapping.js');
    const row = readRow(title) as unknown as Parameters<typeof pick.pickVoiceForEngine>[1];
    const base = pick.pickVoiceForEngine('qwen', row);
    const variants = (row as { overrideTtsVoices?: { qwen?: { variants?: Record<string, { name: string }> } } })
      .overrideTtsVoices?.qwen?.variants;
    return pick.pickEmotionVariantVoice('qwen', variants, emotion, base, false);
  };
  const resolves = async (title: string, emotion: string) =>
    existsSync(join(qwenDir(), `${await renderKey(title, emotion)}.pt`));

  it('control: before any design the declined row renders angry from a file that exists', async () => {
    seedVoiced();
    expect(await resolves('Book Two', 'angry')).toBe(true);
  });

  it('preview then Cancel: an angry line still resolves to a file', async () => {
    seedVoiced();
    const res = await design(() => bookTwoId, { preview: true });
    expect(res.status).toBe(200);
    const discard = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/discard-voice`)
      .send({ previewVoiceId: requestedVoiceIds[0], sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(discard.status).toBe(200);
    expect(await resolves('Book Two', 'angry')).toBe(true);
  });

  it('direct base design (no preview): an angry line still resolves to a file', async () => {
    seedVoiced();
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(await resolves('Book Two', 'angry')).toBe(true);
  });

  it('designing a second emotion: both the new and the earlier emotion resolve', async () => {
    seedVoiced();
    const res = await design(() => bookTwoId, { emotion: 'sad' });
    expect(res.status).toBe(200);
    expect(await resolves('Book Two', 'sad')).toBe(true);
    expect(await resolves('Book Two', 'angry')).toBe(true);
  });

  it('Book One keeps its variant slot and file', async () => {
    seedVoiced();
    const one = { ...readRow('Book One'), ...voiced };
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [one] }));
    await design(() => bookTwoId);
    expect(await resolves('Book One', 'angry')).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-u_shared__angry.pt'))).toBe(true);
  });
});

/* Review pass 1, finding 4 — the drawer's Save (PUT /api/voices/:id/override,
   scope series) and the single/bulk design auto-persist funnel through
   applyOverrideToCastFiles, which matches on the shared `voiceId`. A declined,
   forked row still shares it, so the write must not land on the earlier book. */
describe('#3992 — a forked row’s Save cannot write another book’s row', () => {
  const put = (bookId: string, name: string) =>
    request(app)
      .put('/api/voices/v_wren/override')
      .send({ override: { engine: 'qwen', name }, scope: 'series', bookId });
  const qwenName = (title: string) =>
    (readRow(title).overrideTtsVoices as { qwen?: { name?: string } } | undefined)?.qwen?.name;
  const linkTwoToOne = () => {
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));
  };

  it('Save after a redesign leaves Book One’s row unchanged', async () => {
    seed({});
    writeFileSync(
      castPath('Book One'),
      JSON.stringify({ characters: [{ ...readRow('Book One'), ttsEngine: 'kokoro' }] }),
    );
    const before = readRow('Book One');
    expect((await design(() => bookTwoId)).status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid as string;

    const saved = await put(bookTwoId, `qwen-${fresh}`);
    expect(saved.status).toBe(204);
    expect(readRow('Book One')).toEqual(before);
    expect(qwenName('Book Two')).toBe(`qwen-${fresh}`);
    expect(readRow('Book Two').ttsEngine).toBe('qwen');
  });

  it('Book One’s designed-persona still answers from Book One’s own sidecar json', async () => {
    seed({});
    expect((await design(() => bookTwoId)).status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid as string;
    await put(bookTwoId, `qwen-${fresh}`);

    const got = await request(app).get(`/api/books/${bookOneId}/cast/wren/designed-persona`);
    expect(got.status).toBe(200);
    expect(got.body.instruct).toBe('book one');
  });

  it('Linked rows still propagate: both rows sharing u_shared take the Save', async () => {
    seed({});
    linkTwoToOne();
    const saved = await put(bookTwoId, 'qwen-u_shared');
    expect(saved.status).toBe(204);
    expect(qwenName('Book One')).toBe('qwen-u_shared');
    expect(qwenName('Book Two')).toBe('qwen-u_shared');
    expect(readRow('Book One').ttsEngine).toBe('qwen');
  });

  it('A sibling with no uuid of its own still takes the Save, as before', async () => {
    seed({});
    const one = { ...readRow('Book One') };
    delete one.voiceUuid;
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [one] }));
    const saved = await put(bookTwoId, 'qwen-u_shared');
    expect(saved.status).toBe(204);
    expect(qwenName('Book One')).toBe('qwen-u_shared');
  });
});

/* Review pass 1, finding 5 — a declined row that never got a uuid takes the
   series mint, which stamps the earlier book too and so moves ITS render key
   onto the redesigned bytes. Both rows carry the legacy name-derived key
   `qwen-v_wren` and the earlier book's bytes live there. */
describe('#3992 — a declined row with no uuid does not move the earlier book’s key', () => {
  const legacy = { ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
  const noUuid = (title: string, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { ...readRow(title), ...legacy, ...extra };
    delete row.voiceUuid;
    writeFileSync(castPath(title), JSON.stringify({ characters: [row] }));
  };
  const seedLegacy = (twoExtra: Record<string, unknown> = {}) => {
    seed({});
    noUuid('Book One');
    noUuid('Book Two', twoExtra);
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
    writeFileSync(join(qwenDir(), 'qwen-v_wren.json'), ORIG_JSON);
  };
  const keyOf = async (title: string) => {
    const pick = await import('../tts/voice-mapping.js');
    return pick.pickVoiceForEngine('qwen', readRow(title) as unknown as Parameters<typeof pick.pickVoiceForEngine>[1]);
  };

  it('Book One keeps qwen-v_wren and its bytes; Book Two gets its own uuid', async () => {
    seedLegacy();
    expect(await keyOf('Book One')).toBe('qwen-v_wren');
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);

    expect(readRow('Book One').voiceUuid).toBeUndefined();
    expect(await keyOf('Book One')).toBe('qwen-v_wren');
    expect(readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT)).toBe(true);
    const fresh = readRow('Book Two').voiceUuid as string;
    expect(fresh).toBeTruthy();
    expect(requestedVoiceIds).toEqual([`qwen-${fresh}`]);
  });

  it('preview then Cancel: Book Two sits on its own copy of the earlier bytes', async () => {
    seedLegacy();
    const res = await design(() => bookTwoId, { preview: true });
    expect(res.status).toBe(200);
    const discard = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/discard-voice`)
      .send({ previewVoiceId: requestedVoiceIds[0], sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(discard.status).toBe(200);
    const key = await keyOf('Book Two');
    expect(key).not.toBe('qwen-v_wren');
    expect(readFileSync(join(qwenDir(), `${key}.pt`)).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT)).toBe(true);
  });

  it('Linked (Book Two names Book One): the series mint still stamps both rows with one uuid', async () => {
    seedLegacy({ matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } });
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(fresh).toBeTruthy();
    expect(readRow('Book One').voiceUuid).toBe(fresh);
  });

  it('Nobody has designed yet: the series mint still stamps both rows with one uuid', async () => {
    seed({});
    noUuid('Book One', { overrideTtsVoices: undefined, ttsEngine: undefined });
    noUuid('Book Two', { overrideTtsVoices: undefined, ttsEngine: undefined });
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(fresh).toBeTruthy();
    expect(readRow('Book One').voiceUuid).toBe(fresh);
  });
});

/* Review pass 1, finding 6 — the fork decision and the variant scan read every
   other book's cast.json, and readJson throws on a parse error. One truncated
   file elsewhere in the library must not fail a design or a promote. */
describe('#3992 — an unreadable cast.json elsewhere does not fail a design or promote', () => {
  const corrupt = () => {
    const dir = join(workspaceRoot, 'books', 'Someone Else', 'Standalones', 'Unrelated', '.audiobook');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cast.json'), '{"characters":[{"id":');
  };
  const solo = (uuid: string, extra: Record<string, unknown> = {}) => {
    seed({});
    rmSync(bookDir('Book Two'), { recursive: true, force: true });
    const one = { ...readRow('Book One'), voiceUuid: uuid, ...extra };
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [one] }));
    writeFileSync(join(qwenDir(), `qwen-${uuid}.pt`), ORIG_PT);
  };

  it('design of a sole-holder row answers 200 and keeps its uuid', async () => {
    solo('u_solo');
    corrupt();
    const res = await design(() => bookOneId);
    expect(res.status).toBe(200);
    expect(readRow('Book One').voiceUuid).toBe('u_solo');
    expect(requestedVoiceIds).toEqual(['qwen-u_solo']);
  });

  it('a declined fork still forks when an unrelated book is unreadable', async () => {
    seed({});
    corrupt();
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
  });

  it('promote answers 200 and keeps the variant file it can no longer prove unshared', async () => {
    const bytes = Buffer.from('SOLO-ANGRY');
    solo('u_solo', {
      overrideTtsVoices: { qwen: { name: 'qwen-u_solo', variants: { angry: { name: 'qwen-u_solo__angry' } } } },
    });
    writeFileSync(join(qwenDir(), 'qwen-u_solo__angry.pt'), bytes);
    writeFileSync(join(qwenDir(), 'qwen-u_solo-preview.pt'), NEW_PT);
    corrupt();
    const res = await request(app)
      .post(`/api/books/${bookOneId}/cast/wren/promote-voice`)
      .send({ previewVoiceId: 'qwen-u_solo-preview', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status).toBe(200);
    expect((readRow('Book One').overrideTtsVoices as { qwen?: { variants?: unknown } }).qwen?.variants).toBeUndefined();
    expect(readFileSync(join(qwenDir(), 'qwen-u_solo__angry.pt')).equals(bytes)).toBe(true);
  });

  it('the book being designed itself being unreadable still fails the request', async () => {
    solo('u_solo');
    writeFileSync(castPath('Book One'), '{"characters":[{"id":');
    const res = await design(() => bookOneId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(requestedVoiceIds).toEqual([]);
  });
});

/* Review pass 1, finding 7 — only an ABSENT source (ENOENT) may be skipped
   when the base family is copied. Any other failure aborts the fork before the
   stamp, removes what it already copied, and fails the request. */
describe('#3992 — a failed copy aborts the fork', () => {
  const qwenFiles = () => readdirSync(qwenDir()).sort();

  it('EBUSY on the .json: 500 with a path-free body, row unstamped, no stray copies', async () => {
    seed({});
    const before = qwenFiles();
    failCopyOf.suffix = 'qwen-u_shared.json';
    const res = await design(() => bookTwoId, { preview: true });
    failCopyOf.suffix = null;

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/EBUSY|copyfile|qwen-u_shared/);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(requestedVoiceIds).toEqual([]);
    expect(qwenFiles()).toEqual(before);
  });

  it('EBUSY on the .pt: the same', async () => {
    seed({});
    const before = qwenFiles();
    failCopyOf.suffix = 'qwen-u_shared.pt';
    const res = await design(() => bookTwoId, { preview: true });
    failCopyOf.suffix = null;

    expect(res.status).toBe(500);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(qwenFiles()).toEqual(before);
  });

  it('a source that is simply absent is still skipped: the fork goes ahead', async () => {
    seed({});
    rmSync(join(qwenDir(), 'qwen-u_shared.json'));
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
  });
});

describe('#3992 — promote / DELETE keep the earlier book’s variant files', () => {
  const VAR_BYTES = Buffer.from('BOOK-ONE-ANGRY-VARIANT');
  const variantFile = () => join(qwenDir(), 'qwen-u_shared__angry.pt');
  const withVariant = (uuid: string) => ({
    voiceUuid: uuid,
    overrideTtsVoices: {
      qwen: { name: `qwen-${uuid}`, variants: { angry: { name: 'qwen-u_shared__angry' } } },
    },
  });
  /* the mocked sidecar evict re-creates `<voiceId>.pt` with NEW_PT, so "torn
     down" reads as: absent, or no longer the original bytes */
  const gone = () => !existsSync(variantFile()) || !readFileSync(variantFile()).equals(VAR_BYTES);
  const slotOf = (title: string) =>
    (readRow(title).overrideTtsVoices as { qwen?: { variants?: unknown } } | undefined)?.qwen
      ?.variants;

  /* Book One holds the shared variant; Book Two is `uuid` with the same map. */
  function seedBoth(bookTwoUuid: string) {
    seed({ ...withVariant(bookTwoUuid) });
    const one = { ...readRow('Book One'), ...withVariant('u_shared') };
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [one] }));
    writeFileSync(variantFile(), VAR_BYTES);
  }

  const promote = async (uuid: string) => {
    const previewId = `qwen-${uuid}-preview`;
    writeFileSync(join(qwenDir(), `${previewId}.pt`), NEW_PT);
    return request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/promote-voice`)
      .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
  };
  const del = () =>
    request(app).delete(`/api/books/${bookTwoId}/cast/wren/emotion-variant/angry`);

  it('Forked promote: Book Two’s variants go, Book One’s variant file is byte-identical', async () => {
    seedBoth('u_new');
    const res = await promote('u_new');
    expect(res.status).toBe(200);
    expect(slotOf('Book Two')).toBeUndefined();
    expect(readFileSync(variantFile()).equals(VAR_BYTES)).toBe(true);
    expect(slotOf('Book One')).toBeDefined();
  });

  it('Forked DELETE: Book One’s file byte-identical, Book Two’s slot gone', async () => {
    seedBoth('u_new');
    const res = await del();
    expect(res.status).toBe(200);
    expect(slotOf('Book Two')).toBeUndefined();
    expect(readFileSync(variantFile()).equals(VAR_BYTES)).toBe(true);
  });

  it('Linked promote: both rows share u_shared, so the shared variant file is deleted', async () => {
    seedBoth('u_shared');
    const res = await promote('u_shared');
    expect(res.status).toBe(200);
    expect(slotOf('Book Two')).toBeUndefined();
    expect(gone()).toBe(true);
  });

  it('Sole owner: no other row names the variant, so it is deleted as before', async () => {
    seedBoth('u_new');
    const one = { ...readRow('Book One') };
    delete one.overrideTtsVoices;
    writeFileSync(castPath('Book One'), JSON.stringify({ characters: [one] }));
    const res = await del();
    expect(res.status).toBe(200);
    expect(gone()).toBe(true);
  });
});
