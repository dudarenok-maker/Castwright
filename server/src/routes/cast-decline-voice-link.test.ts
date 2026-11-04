/* #3992 — POST /api/books/:bookId/cast/:characterId/decline-voice-link, the
   only writer of the `declinedVoiceFrom` ("Don't reuse") marker. Since the
   decline-time redesign it also establishes the invariant every design relies
   on: after it succeeds the row is on its own voice that no other book's row
   holds, other than its followers (the whole chain that links down to it),
   which move with it. Real cast.json
   files and real voice files; the manual re-link (cast/link-prior) that clears
   the marker again is covered at the end. Same lazy-import pattern as
   cast-not-linked-to.test.ts so WORKSPACE_DIR is set before paths.ts binds. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Runs once, just before the separation takes its book-ops: lets a test change a
   book between the lock-free plan and the locked step. */
const beforeLocks = vi.hoisted(() => ({ fn: null as (() => void) | null }));
/* Fails any fs write whose path contains this text (an EBUSY from a scanner). */
const failWriteIn = vi.hoisted(() => ({ text: null as string | null }));
/* Fails the copy of a source whose name ends with this (an EBUSY, not an ENOENT). */
const failCopyOf = vi.hoisted(() => ({ suffix: null as string | null }));
/* Pins the next minted uuid, to land a copy on a destination that already exists. */
const forcedNanoid = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nanoid')>();
  return { ...actual, nanoid: (...a: Parameters<typeof actual.nanoid>) => forcedNanoid.value ?? actual.nanoid(...a) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const ebusy = (syscall: string, path: string) =>
    Object.assign(new Error(`EBUSY: resource busy or locked, ${syscall} '${path}'`), { code: 'EBUSY', syscall, path });
  const copyFile = async (src: unknown, dest: unknown, mode?: number) => {
    if (failCopyOf.suffix && String(src).endsWith(failCopyOf.suffix)) throw ebusy('copyfile', String(src));
    return actual.copyFile(src as string, dest as string, mode);
  };
  const writeFile = async (path: unknown, ...rest: unknown[]) => {
    if (failWriteIn.text && String(path).includes(failWriteIn.text)) throw ebusy('open', String(path));
    return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
  };
  return { ...actual, default: { ...actual, copyFile, writeFile }, copyFile, writeFile };
});
vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  const withBookOps: typeof actual.withBookOps = (ids, fn, opts) => {
    if (beforeLocks.fn) {
      const run = beforeLocks.fn;
      beforeLocks.fn = null;
      run();
    }
    return actual.withBookOps(ids, fn, opts);
  };
  return { ...actual, withBookOps };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const TITLES = ['Book One', 'Book Two', 'Book Three', 'Book Four'] as const;
type Title = (typeof TITLES)[number];

let root: string;
let app: Express;
const ids = {} as Record<Title, string>;
let oneId: string;
let twoId: string;

const dirOf = (title: string) => join(root, 'books', AUTHOR, SERIES, title);
const castFile = (title: string) => join(dirOf(title), '.audiobook', 'cast.json');
const readRows = (title: string): Array<Record<string, any>> =>
  JSON.parse(readFileSync(castFile(title), 'utf8')).characters;
const qwenDir = () => join(root, 'voices', 'qwen');
const voiceFile = (name: string) => join(qwenDir(), name);
const voiceFiles = () => readdirSync(qwenDir()).sort();

function writeBook(title: string, id: string, characters: object[]) {
  const dir = dirOf(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}
const book = (t: Title, characters: object[]) => writeBook(t, ids[t], characters);

const wren = (extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  ...extra,
});
const linkTo = (t: Title) => ({ matchedFrom: { bookId: ids[t], characterId: 'wren', bookTitle: t, confidence: 1 } });
const slot = (u: string, variants: string[] = []) => ({
  overrideTtsVoices: {
    qwen: {
      name: `qwen-${u}`,
      ...(variants.length ? { variants: Object.fromEntries(variants.map((e) => [e, { name: `qwen-${u}__${e}` }])) } : {}),
    },
  },
});

/* Book One's designed voice family, and a check that every file of it is byte-identical. */
const FAMILY: Record<string, Buffer> = {
  'qwen-u_shared.pt': Buffer.from('ONE-PT'),
  'qwen-u_shared.json': Buffer.from('{"instruct":"book one"}'),
  'qwen-u_shared__1.7b.pt': Buffer.from('ONE-1.7B'),
  'qwen-u_shared__master.wav': Buffer.from('ONE-MASTER'),
  'qwen-u_shared__angry.pt': Buffer.from('ONE-ANGRY'),
};
const writeFamily = () => {
  for (const [n, b] of Object.entries(FAMILY)) writeFileSync(voiceFile(n), b);
};
const familyIntact = () => {
  for (const [n, b] of Object.entries(FAMILY)) expect(readFileSync(voiceFile(n)).equals(b), n).toBe(true);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-decline-voice-link-'));
  process.env.WORKSPACE_DIR = root;
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { castLinkPriorRouter } = await import('./cast-link-prior.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  oneId = ids['Book One'];
  twoId = ids['Book Two'];
  app = express();
  app.use(express.json());
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/books', castLinkPriorRouter);
});

beforeEach(() => {
  beforeLocks.fn = null;
  failWriteIn.text = null;
  failCopyOf.suffix = null;
  forcedNanoid.value = null;
  rmSync(join(root, 'books'), { recursive: true, force: true });
  rmSync(join(root, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeBook('Book One', oneId, [wren({ voiceUuid: 'u_one' })]);
  writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_two' }), { id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const decline = (bookId: string, characterId: string, body: object) =>
  request(app).post(`/api/books/${bookId}/cast/${characterId}/decline-voice-link`).send(body);

/* The shared shape: Book Two linked to Book One, both on u_shared, One designed. */
function seedShared(twoExtra: Record<string, unknown> = {}) {
  book('Book One', [wren({ voiceUuid: 'u_shared', ...slot('u_shared', ['angry']) })]);
  book('Book Two', [wren({ voiceUuid: 'u_shared', voiceState: 'reused', ...linkTo('Book One'), ...slot('u_shared', ['angry']), ...twoExtra })]);
  writeFamily();
}

describe('the marker', () => {
  it('records the declined book on the row, and only that row', async () => {
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ declinedVoiceFrom: [oneId], declinedVoiceUuids: [], voiceUuid: 'u_two' });
    const rows = readRows('Book Two');
    expect(rows[0].declinedVoiceFrom).toEqual([oneId]);
    expect(rows[1].declinedVoiceFrom).toBeUndefined();
    expect(readRows('Book One')[0].declinedVoiceFrom).toBeUndefined();
  });

  it('clears matchedFrom on disk in the same write, mirroring the reducer', async () => {
    const mf = { bookId: oneId, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_two', voiceState: 'reused', matchedFrom: mf })]);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    const row = readRows('Book Two')[0];
    expect('matchedFrom' in row).toBe(false);
    expect(row.voiceState).toBe('generated');
    expect(row.declinedVoiceFrom).toEqual([oneId]);
  });

  it('keeps a locked or tuned voiceState when it clears the link', async () => {
    const mf = { bookId: oneId, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_two', voiceState: 'tuned', matchedFrom: mf })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    const row = readRows('Book Two')[0];
    expect('matchedFrom' in row).toBe(false);
    expect(row.voiceState).toBe('tuned');
  });

  it('leaves a link to a DIFFERENT book alone (the disk moved on since the client read it)', async () => {
    const mf = { bookId: 'another-book', characterId: 'wren', bookTitle: 'Other', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_two', voiceState: 'reused', matchedFrom: mf })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    const row = readRows('Book Two')[0];
    expect(row.matchedFrom).toEqual(mf);
    expect(row.declinedVoiceFrom).toEqual([oneId]);
  });

  it('is idempotent, accumulates distinct books, and a repeat does not rewrite the file', async () => {
    await decline(twoId, 'wren', { fromBookId: oneId });
    const before = readFileSync(castFile('Book Two'), 'utf8');
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe(before);
    const res = await decline(twoId, 'wren', { fromBookId: 'a-deleted-book' });
    expect(res.body.declinedVoiceFrom).toEqual([oneId, 'a-deleted-book']);
  });

  it('keeps every other field of the cast file', async () => {
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_x', voiceState: 'generated', aliases: ['W'] })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readRows('Book Two')[0]).toMatchObject({ voiceUuid: 'u_x', voiceState: 'generated', aliases: ['W'] });
  });
});

describe('the separation: after a decline the row is on a voice no other book holds', () => {
  it('a voice the earlier book holds: a fresh uuid, the base family copied, variants dropped, Book One byte-identical', async () => {
    seedShared();
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    const two = readRows('Book Two')[0];
    const fresh = two.voiceUuid as string;
    expect(fresh).not.toBe('u_shared');
    expect(res.body).toEqual({ declinedVoiceFrom: [oneId], declinedVoiceUuids: ['u_shared'], voiceUuid: fresh });
    expect(two.overrideTtsVoices.qwen.variants).toBeUndefined();
    for (const base of ['.pt', '.json', '__1.7b.pt', '__master.wav']) {
      expect(readFileSync(voiceFile(`qwen-${fresh}${base}`)).equals(FAMILY[`qwen-u_shared${base}`])).toBe(true);
    }
    expect(voiceFiles()).not.toContain(`qwen-${fresh}__angry.pt`); // never an emotion variant
    familyIntact();
    expect(readRows('Book One')[0]).toEqual(wren({ voiceUuid: 'u_shared', ...slot('u_shared', ['angry']) }));
  });

  it('a row whose voice nobody designed yet just gets a fresh uuid: nothing to copy', async () => {
    book('Book One', [wren({ voiceUuid: 'u_shared' })]);
    book('Book Two', [wren({ voiceUuid: 'u_shared', ...linkTo('Book One') })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    expect(res.body.voiceUuid).not.toBe('u_shared');
    expect(voiceFiles()).toEqual([]);
    expect(readRows('Book One')[0].voiceUuid).toBe('u_shared');
  });

  it('a row with no uuid always gets one (a series mint would move the earlier legacy key), copying the legacy family', async () => {
    book('Book One', [wren({ overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } })]);
    book('Book Two', [wren({ ...linkTo('Book One'), overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } })]);
    writeFileSync(voiceFile('qwen-v_wren.pt'), Buffer.from('LEGACY-PT'));
    writeFileSync(voiceFile('qwen-v_wren.json'), Buffer.from('LEGACY-JSON'));
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    const fresh = readRows('Book Two')[0].voiceUuid as string;
    expect(fresh).toBeTruthy();
    expect(res.body.declinedVoiceUuids).toEqual([]); // it held no uuid to name
    expect(readFileSync(voiceFile(`qwen-${fresh}.pt`)).toString()).toBe('LEGACY-PT');
    expect(readRows('Book One')[0].voiceUuid).toBeUndefined(); // the earlier book keeps its legacy key
    expect(readFileSync(voiceFile('qwen-v_wren.pt')).toString()).toBe('LEGACY-PT');
    // ...and a legacy row nobody shares a key with gets one too (the "no voice yet" shape)
    writeBook('Book Two', twoId, [wren()]);
    expect((await decline(twoId, 'wren', { fromBookId: 'a-deleted-book' })).body.voiceUuid).toBeTruthy();
  });

  it('the whole chain moves with it and loses its variants (Three links Two, Four links Three); a stranger stays', async () => {
    seedShared();
    book('Book Three', [
      wren({ voiceUuid: 'u_shared', ...linkTo('Book Two'), ...slot('u_shared', ['angry']) }),
      { ...wren({ id: 'wren_b', voiceUuid: 'u_shared' }) }, // same voiceId in the follower's book: follows it
      { ...wren({ id: 'stranger', voiceId: 'v_other', voiceUuid: 'u_shared' }) }, // another voice: stays
    ]);
    book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Three'), ...slot('u_shared', ['angry']) })]);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    const fresh = readRows('Book Two')[0].voiceUuid;
    expect(fresh).not.toBe('u_shared');
    const three = readRows('Book Three');
    expect(three[0].voiceUuid).toBe(fresh);
    expect(three[0].overrideTtsVoices.qwen.variants).toBeUndefined();
    expect(three[0].matchedFrom.bookId).toBe(twoId); // the link itself is kept
    expect(three[1].voiceUuid).toBe(fresh);
    expect(three[2].voiceUuid).toBe('u_shared');
    const four = readRows('Book Four')[0];
    expect(four.voiceUuid).toBe(fresh);
    expect(four.overrideTtsVoices.qwen.variants).toBeUndefined();
    expect(four.matchedFrom.bookId).toBe(ids['Book Three']);
    expect(readRows('Book One')[0]).toEqual(wren({ voiceUuid: 'u_shared', ...slot('u_shared', ['angry']) }));
    familyIntact();
  });

  it('a branch: two rows linking to Two both move, and what links to either', async () => {
    seedShared();
    book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
    book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    const fresh = readRows('Book Two')[0].voiceUuid;
    expect(fresh).not.toBe('u_shared');
    expect(readRows('Book Three')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book Four')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book One')[0].voiceUuid).toBe('u_shared');
    familyIntact();
  });

  it('a cycle terminates: Two (whose own link names Four) <- Three <- Four all move once, One untouched', async () => {
    seedShared({ matchedFrom: { bookId: ids['Book Four'], characterId: 'wren', bookTitle: 'Book Four', confidence: 1 } });
    book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
    book('Book Four', [
      wren({ voiceUuid: 'u_shared', ...linkTo('Book Three') }),
      // names its own book with no characterId: it names itself
      wren({ id: 'wren_self', voiceId: 'v_self', voiceUuid: 'u_shared', matchedFrom: { bookId: ids['Book Four'], bookTitle: 'Book Four', confidence: 1 } }),
    ]);
    const started = Date.now();
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const fresh = readRows('Book Two')[0].voiceUuid;
    expect(fresh).not.toBe('u_shared');
    expect(readRows('Book Three')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book Four').map((r) => r.voiceUuid)).toEqual([fresh, 'u_shared']);
    expect(readRows('Book One')[0].voiceUuid).toBe('u_shared');
    familyIntact();
  });

  it('a row in the chain that already left the voice stays put, and so does what links to it', async () => {
    seedShared();
    book('Book Three', [wren({ voiceUuid: 'u_three', ...linkTo('Book Two') })]);
    book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Three') })]);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    expect(readRows('Book Two')[0].voiceUuid).not.toBe('u_shared');
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_three');
    expect(readRows('Book Four')[0].voiceUuid).toBe('u_shared');
    familyIntact();
  });

  it('same-book rows on its voice move with it; another voice in the book does not', async () => {
    seedShared();
    const rows = readRows('Book Two');
    writeFileSync(
      castFile('Book Two'),
      JSON.stringify({ characters: [rows[0], { ...rows[0], id: 'wren_b', matchedFrom: undefined }, wren({ id: 'x', voiceId: 'v_x', voiceUuid: 'u_shared' })] }),
    );
    await decline(twoId, 'wren', { fromBookId: oneId });
    const after = readRows('Book Two');
    expect(after[1].voiceUuid).toBe(after[0].voiceUuid);
    expect(after[2].voiceUuid).toBe('u_shared');
  });

  it('only its followers (or nobody) hold the voice: no separation, the marker alone is recorded', async () => {
    book('Book Two', [wren({ voiceUuid: 'u_two', ...slot('u_two', ['angry']) })]);
    book('Book Three', [wren({ voiceUuid: 'u_two', ...linkTo('Book Two') })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.body).toEqual({ declinedVoiceFrom: [oneId], declinedVoiceUuids: [], voiceUuid: 'u_two' });
    expect(Object.keys(readRows('Book Two')[0].overrideTtsVoices.qwen.variants)).toEqual(['angry']);
    expect(voiceFiles()).toEqual([]);
  });

  it('an earlier book that cannot be read still separates (copying writes no other book’s file)', async () => {
    seedShared();
    writeFileSync(castFile('Book One'), '{"characters":[');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    expect(res.body.voiceUuid).not.toBe('u_shared');
    familyIntact();
    expect(readFileSync(castFile('Book One'), 'utf8')).toBe('{"characters":[');
  });

  it('a repeat decline (double click, stale tab) never separates again, whoever later linked to its voice', async () => {
    seedShared();
    await decline(twoId, 'wren', { fromBookId: oneId });
    const fresh = readRows('Book Two')[0].voiceUuid;
    book('Book Three', [wren({ voiceUuid: fresh, ...linkTo('Book Two') })]);
    book('Book Four', [wren({ voiceUuid: fresh, ...linkTo('Book Three') })]); // a second hop
    writeBook('Book Two', twoId, [{ ...readRows('Book Two')[0], ...slot(fresh, ['angry']) }]);
    writeFileSync(join(root, 'books', AUTHOR, SERIES, 'Book One', '.audiobook', 'cast.json'), '{"characters":['); // and a torn book
    const files = voiceFiles();
    const castTwo = readFileSync(castFile('Book Two'), 'utf8');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    expect(res.body.voiceUuid).toBe(fresh);
    expect(Object.keys(readRows('Book Two')[0].overrideTtsVoices.qwen.variants)).toEqual(['angry']);
    expect(readRows('Book Three')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book Four')[0].voiceUuid).toBe(fresh);
    expect(voiceFiles()).toEqual(files);
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe(castTwo); // not even rewritten
  });

  it('a double press separates once: two concurrent declines answer the same uuid and copy one family', async () => {
    seedShared();
    book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
    const [a, b] = await Promise.all([
      decline(twoId, 'wren', { fromBookId: oneId }),
      decline(twoId, 'wren', { fromBookId: oneId }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const fresh = readRows('Book Two')[0].voiceUuid;
    expect(fresh).not.toBe('u_shared');
    expect(a.body.voiceUuid).toBe(fresh);
    expect(b.body.voiceUuid).toBe(fresh);
    expect(readRows('Book Three')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_shared']);
    // Book One's five files plus ONE copied base family (four files), never two
    expect(voiceFiles().filter((f) => !f.startsWith('qwen-u_shared'))).toHaveLength(4);
    familyIntact();
  });
});

describe('the step lands whole or not at all', () => {
  const unchanged = () => {
    expect(readRows('Book Two')[0].voiceUuid).toBe('u_shared');
    expect(readRows('Book Two')[0].matchedFrom.bookId).toBe(oneId);
    expect(readRows('Book Two')[0].declinedVoiceFrom).toBeUndefined();
    expect(voiceFiles()).toEqual(Object.keys(FAMILY).sort()); // no stray copies
    familyIntact();
  };
  const seedChain = () => {
    seedShared();
    book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
  };

  it('a failed write of the row AFTER its follower moved rolls the follower back and removes the copies; the retry lands', async () => {
    seedChain();
    failWriteIn.text = 'Book Two';
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(root); // path-free
    unchanged();
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_shared');
    failWriteIn.text = null;
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    expect(readRows('Book Three')[0].voiceUuid).toBe(readRows('Book Two')[0].voiceUuid);
    familyIntact();
  });

  it('a failed write to the follower changes nothing', async () => {
    seedChain();
    failWriteIn.text = 'Book Three';
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(500);
    unchanged();
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_shared');
  });

  it('a failed copy (EBUSY, not an absent source) changes nothing and leaves no partial copies', async () => {
    seedShared();
    failCopyOf.suffix = 'qwen-u_shared.json';
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(root);
    unchanged();
  });

  it('never overwrites: a destination that already exists fails the step and is left alone', async () => {
    seedShared();
    forcedNanoid.value = 'u_taken';
    writeFileSync(voiceFile('qwen-u_taken.pt'), Buffer.from('SOMEONE-ELSES'));
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(500);
    expect(readFileSync(voiceFile('qwen-u_taken.pt')).toString()).toBe('SOMEONE-ELSES');
    expect(readRows('Book Two')[0].voiceUuid).toBe('u_shared');
  });

  it('a follower that links in between the plan and the locks fails the step with a retry sentence; the retry carries it', async () => {
    seedShared();
    book('Book Three', [wren({ voiceUuid: 'u_shared' })]);
    beforeLocks.fn = () => book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Two') })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    unchanged();
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    expect(readRows('Book Three')[0].voiceUuid).toBe(readRows('Book Two')[0].voiceUuid);
  });

  it('a follower whose book becomes unreadable in between fails the step, never leaving it behind', async () => {
    seedChain();
    beforeLocks.fn = () => writeFileSync(castFile('Book Three'), '{"characters":[');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    unchanged();
  });

  it('a follower that stops following in between fails the step with a retry sentence; the retry leaves it put', async () => {
    seedChain();
    beforeLocks.fn = () => book('Book Three', [wren({ voiceUuid: 'u_shared', ...linkTo('Book One') })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    unchanged();
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    expect(readRows('Book Two')[0].voiceUuid).not.toBe('u_shared');
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_shared');
    familyIntact();
  });

  it('a book two hops down the chain becoming unreadable in between fails the step; nothing is written', async () => {
    seedChain();
    book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Three') })]);
    beforeLocks.fn = () => writeFileSync(castFile('Book Four'), '{"characters":[');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    expect(JSON.stringify(res.body)).not.toContain(root);
    unchanged();
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_shared');
    expect(readFileSync(castFile('Book Four'), 'utf8')).toBe('{"characters":[');
  });

  it('a row joining the chain two hops down in between fails the step; the retry carries it', async () => {
    seedChain();
    book('Book Four', [wren({ voiceUuid: 'u_shared' })]);
    beforeLocks.fn = () => book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Three') })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    unchanged();
    expect(readRows('Book Four')[0].voiceUuid).toBe('u_shared');
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(200);
    const fresh = readRows('Book Two')[0].voiceUuid;
    expect(readRows('Book Three')[0].voiceUuid).toBe(fresh);
    expect(readRows('Book Four')[0].voiceUuid).toBe(fresh);
  });

  it('a failed write two hops down rolls back every book already written and removes the copies', async () => {
    seedChain();
    book('Book Four', [wren({ voiceUuid: 'u_shared', ...linkTo('Book Three') })]);
    failWriteIn.text = 'Book Four';
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(500);
    unchanged();
    expect(readRows('Book Three')[0].voiceUuid).toBe('u_shared');
    expect(readRows('Book Four')[0].voiceUuid).toBe('u_shared');
  });

  it('the row vanishing in between answers 404 and leaves no copies', async () => {
    seedShared();
    beforeLocks.fn = () => book('Book Two', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(404);
    expect(voiceFiles()).toEqual(Object.keys(FAMILY).sort());
  });

  it('a cast.json that cannot be read answers a path-free 500 and is left exactly as it was', async () => {
    writeFileSync(castFile('Book Two'), '{"characters":[{"id":');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe('{"characters":[{"id":');
    rmSync(castFile('Book Two'));
    mkdirSync(castFile('Book Two')); // EISDIR names the path in its message
    const dir = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(dir.status).toBe(500);
    expect(JSON.stringify(dir.body)).not.toContain(root);
  });
});

describe('request validation', () => {
  it('400 on a missing or self fromBookId, writing nothing', async () => {
    const before = readFileSync(castFile('Book Two'), 'utf8');
    expect((await decline(twoId, 'wren', {})).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: '  ' })).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: 7 })).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: twoId })).status).toBe(400);
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe(before);
  });

  it('404 on an unknown character or book, 409 on an empty cast', async () => {
    expect((await decline(twoId, 'nobody', { fromBookId: oneId })).status).toBe(404);
    expect((await decline('no-such-book', 'wren', { fromBookId: oneId })).status).toBe(404);
    writeBook('Book Two', twoId, []);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(409);
  });
});

describe('cast/link-prior clears the marker for the book it links to', () => {
  const link = () =>
    request(app)
      .post(`/api/books/${twoId}/cast/link-prior`)
      .send({ sourceCharacterId: 'wren', targetBookId: oneId, targetCharacterId: 'wren' });

  it('drops only the re-linked book from the marker, forcing the write even when nothing else changed', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: [oneId, 'another-book'] })]);
    const res = await link();
    expect(res.status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceFrom).toEqual(['another-book']);
  });

  it('removes the field entirely when it was the last entry', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: [oneId] })]);
    expect((await link()).status).toBe(200);
    expect('declinedVoiceFrom' in readRows('Book Two')[0]).toBe(false);
  });

  it('drops the re-linked voice uuid from declinedVoiceUuids too (pass-2 V)', async () => {
    writeBook('Book One', oneId, [wren({ voiceUuid: 'u_shared' })]);
    writeBook('Book Two', twoId, [
      wren({ voiceUuid: 'u_shared', declinedVoiceFrom: [oneId], declinedVoiceUuids: ['u_shared', 'u_keep'] }),
    ]);
    expect((await link()).status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_keep']);
    expect('declinedVoiceFrom' in readRows('Book Two')[0]).toBe(false);
  });

  it('leaves a marker that names a different book alone', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: ['another-book'] })]);
    expect((await link()).status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceFrom).toEqual(['another-book']);
  });
});
