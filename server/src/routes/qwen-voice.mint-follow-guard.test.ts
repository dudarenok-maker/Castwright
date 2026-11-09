/* #4037 — a take that landed on the legacy key follows a mint's re-key (see
   variantOnMintedKey) only onto a row the mint re-keyed: one whose new key
   `qwen-<uuid>` still holds the base the take was made on. A row that merely carries a
   uuid on the same link id (its own design, a redesigned shared key, a library slot)
   keeps what it has. Real cast.json files; Repro A goes through the real
   POST /cast/link-prior route, Repro B through the real mint. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const series = { author: AUTHOR, series: SERIES };

let workspaceRoot: string;
let app: Express;
let ensure: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;
let persistVariant: typeof import('./qwen-voice.js').persistEmotionVariant;
let markRedesigned: typeof import('./qwen-voice.js').markBaseRedesigned;
let dropStale: typeof import('../workspace/variant-base-rev.js').dropStaleVariants;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const rowOf = (t: string, id = 'wren'): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters.find((c: { id: string }) => c.id === id);
const file = (name: string) => join(qwenDir(), name);
const plant = (name: string, body: string) => writeFileSync(file(name), Buffer.from(body));
const read = (name: string) => readFileSync(file(name), 'utf8');
const keptSlot = async (t: string, emotion: string): Promise<boolean> => {
  const [row] = await dropStale([rowOf(t)]);
  return !!(row as Record<string, any>).overrideTtsVoices?.qwen?.variants?.[emotion];
};

function writeBook(t: string, rows: Array<Record<string, unknown>>, confirmed = true) {
  const dir = bookDir(t);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `b_${t}`,
      manuscriptId: `m_${t}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: confirmed,
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-mint-follow-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  ({
    ensureCharacterVoiceUuid: ensure,
    persistEmotionVariant: persistVariant,
    markBaseRedesigned: markRedesigned,
  } = await import('./qwen-voice.js'));
  ({ dropStaleVariants: dropStale } = await import('../workspace/variant-base-rev.js'));
  const { castLinkPriorRouter } = await import('./cast-link-prior.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', castLinkPriorRouter);
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('the take follows only a row the mint re-keyed (#4037)', () => {
  it('A: a row that took its own uuid is never handed another voice (linked through POST /cast/link-prior)', async () => {
    reset();
    writeBook('Book One', [legacy]);
    writeBook('Book Two', [
      {
        ...legacy,
        id: 'wren2',
        voiceId: 'v_wren2',
        voiceUuid: 'u_own',
        overrideTtsVoices: { qwen: { name: 'qwen-u_own', variants: { sad: { name: 'qwen-u_own__sad' } } } },
      },
    ]);
    plant('qwen-v_wren.pt', 'WREN-BASE');
    plant('qwen-u_own.pt', 'OWN-BASE');
    plant('qwen-u_own__sad.pt', 'OWN-SAD');
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent('b_Book Two')}/cast/link-prior`)
      .send({ sourceCharacterId: 'wren2', targetBookId: 'b_Book One', targetCharacterId: 'wren' });
    expect(res.status).toBe(200);
    expect(rowOf('Book Two', 'wren2')).toMatchObject({ voiceId: 'v_wren', voiceUuid: 'u_own' });

    plant('qwen-v_wren__sad.pt', 'WREN-SAD');
    expect(await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');

    expect(read('qwen-u_own__sad.pt')).toBe('OWN-SAD');
    expect(rowOf('Book Two', 'wren2').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_own__sad');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-v_wren__sad');
  });

  it('B: a current take on the re-keyed key is never replaced by a stale one (real mint, base redesigned since)', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } }]);
    writeBook('Book Two', [{ ...legacy }], false); // unconfirmed: the mint walk skips it
    plant('qwen-v_wren.pt', 'OLD-BASE');
    const uuid = (await ensure(bookDir('Book One'), 'wren', series))!;
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
    /* the base design lands on the new key (redesign, rev R), and Book One designs angry on it */
    plant(`qwen-${uuid}.pt`, 'NEW-BASE');
    await markRedesigned(`qwen-${uuid}`);
    const rev = JSON.parse(read(`qwen-${uuid}.json`)).rev;
    plant(`qwen-${uuid}__angry.pt`, 'U-ANGRY');
    plant(`qwen-${uuid}__angry.json`, JSON.stringify({ baseRev: rev }));
    const cast = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    cast.characters[0].overrideTtsVoices.qwen.variants = { angry: { name: `qwen-${uuid}__angry` } };
    writeFileSync(castPath('Book One'), JSON.stringify(cast));
    expect(await keptSlot('Book One', 'angry')).toBe(true);

    /* Book Two is confirmed later, still on the legacy key, and designs angry on the old base */
    writeBook('Book Two', [{ ...legacy }], true);
    plant('qwen-v_wren__angry.pt', 'OLD-ANGRY');
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'angry', 'qwen-v_wren__angry', series)).toBe('applied');

    expect(read(`qwen-${uuid}__angry.pt`)).toBe('U-ANGRY');
    expect(await keptSlot('Book One', 'angry')).toBe(true);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('E: with the base unchanged, a take current on the new key is not replaced by one stale against it', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    writeBook('Book Two', [{ ...legacy }]);
    plant('qwen-v_wren.pt', 'SAME-BASE');
    plant('qwen-u_one.pt', 'SAME-BASE');
    plant('qwen-u_one.json', JSON.stringify({ rev: 'R2' }));
    plant('qwen-u_one__sad.pt', 'CURRENT-SAD');
    plant('qwen-u_one__sad.json', JSON.stringify({ baseRev: 'R2' }));
    plant('qwen-v_wren__sad.pt', 'STALE-SAD');
    plant('qwen-v_wren__sad.json', JSON.stringify({ baseRev: 'R1' }));
    expect(await persistVariant(bookDir('Book Two'), 'wren', 'sad', 'qwen-v_wren__sad', series)).toBe('applied');
    expect(read('qwen-u_one__sad.pt')).toBe('CURRENT-SAD');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_one__sad');
  });

  it('C: a library slot row on the link id gets no slot named for its uuid', async () => {
    reset();
    writeBook('Book One', [legacy]);
    writeBook('Book Two', [
      {
        ...legacy,
        voiceUuid: 'u_lib_row',
        overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1' } },
      },
    ]);
    plant('qwen-v_wren.pt', 'SAME-BASE');
    plant('qwen-u_lib_row.pt', 'SAME-BASE'); // would pass the base check: only the library guard stops it
    plant('qwen-v_wren__sad.pt', 'SAD');
    await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-v_wren__sad', series);
    expect(rowOf('Book Two').overrideTtsVoices.qwen.variants?.sad).toBeUndefined();
    expect(existsSync(file('qwen-u_lib_row__sad.pt'))).toBe(false);
  });

  it('D: a take anchored on another uuid does not follow onto a row of the link id', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_one' }]);
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_two' }]);
    plant('qwen-v_wren.pt', 'SAME-BASE');
    plant('qwen-u_one.pt', 'SAME-BASE');
    plant('qwen-u_two.pt', 'SAME-BASE');
    plant('qwen-u_one__sad.pt', 'SAD');
    const out = await persistVariant(bookDir('Book One'), 'wren', 'sad', 'qwen-u_one__sad', series);
    expect(out).toBe('applied');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_one__sad');
    expect(rowOf('Book Two').overrideTtsVoices?.qwen?.variants?.sad).toBeUndefined();
    expect(existsSync(file('qwen-u_two__sad.pt'))).toBe(false);
  });
});
