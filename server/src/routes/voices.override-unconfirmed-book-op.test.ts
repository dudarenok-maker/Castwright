/* Review pass 4 (🟠2) -- the drawer's series Save from an UNCONFIRMED book writes that
   book alone (F8), and it decides and writes under the book's own book-op, never from
   a lock-free `peekBook` result:

   - a folder move that lands between the decision and the write (the #3711 shape: the
     write re-created the OLD folder holding only a `cast.json`);
   - a Start fresh that lands after a lock-free read said "confirmed" (the series walk
     then rewrote the confirmed mates).

   The first is made to happen at the write by holding the move behind the Save's own
   read (a fire-and-forget move that the hook waits on): with the book-op held for the
   whole span the move queues behind the write and the folder ends up renamed with the
   override in it; without it the write lands in the old, already-moved path. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const arm = vi.hoisted(() => ({ path: '' as string, bookId: '', newDir: '', fired: false, n: 0, at: 3 }));
const moveDone = vi.hoisted(() => ({ p: null as Promise<unknown> | null }));
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  const readJson: typeof actual.readJson = (async (p: string, ...rest: unknown[]) => {
    const out = await (actual.readJson as any)(p, ...rest);
    if (arm.path && p.toLowerCase() === arm.path.toLowerCase()) arm.n++;
    if (arm.path && p.toLowerCase() === arm.path.toLowerCase() && !arm.fired && arm.n === arm.at) {
      arm.fired = true;
      const { withBookOp, moveBookFolder } = await import('../workspace/book-op-lock.js');
      /* Fire and forget: a Save holding the book-op keeps the move queued behind it. */
      moveDone.p = withBookOp(arm.bookId, (b) => moveBookFolder(b, arm.newDir, (s) => ({ ...s, title: 'Book Three Renamed' })));
      await new Promise((r) => setTimeout(r, 400));
    }
    return out;
  }) as any;
  return { ...actual, readJson };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
let root: string;
let app: Express;
const bookDir = (t: string) => join(root, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const statePath = (t: string) => join(bookDir(t), '.audiobook', 'state.json');
const idOf = async (t: string) => (await import('../workspace/paths.js')).makeBookId(AUTHOR, SERIES, t);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'castwright-override-book-op-'));
  process.env.WORKSPACE_DIR = root;
  const { voicesRouter } = await import('./voices.js');
  app = express();
  app.use(express.json());
  app.use('/api/voices', voicesRouter);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function writeBook(t: string, confirmed: boolean) {
  const bookId = await idOf(t);
  mkdirSync(join(bookDir(t), '.audiobook'), { recursive: true });
  writeFileSync(
    statePath(t),
    JSON.stringify({ bookId, manuscriptId: `m_${bookId}`, title: t, author: AUTHOR, series: SERIES, isStandalone: false, castConfirmed: confirmed, seriesPosition: null, chapters: [], manuscriptFile: 'm.txt', language: 'en', coverGradient: ['#000', '#fff'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }),
  );
  writeFileSync(join(bookDir(t), 'm.txt'), 'x');
  writeFileSync(castPath(t), JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', voiceId: 'v_wren' }] }));
  return bookId;
}
const save = (bookId: string, name = 'qwen-u3') =>
  request(app).put('/api/voices/v_wren/override').send({ override: { engine: 'qwen', name }, scope: 'series', bookId });
const slot = (t: string) => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0].overrideTtsVoices?.qwen?.name;

describe('PUT /api/voices/:voiceId/override -- an unconfirmed book Saves under its own book-op', () => {
  it('a folder move that lands at the write queues behind it: the moved book holds the override and no stray old folder appears', async () => {
    const id = await writeBook('Book Three', false);
    arm.path = castPath('Book Three');
    arm.bookId = id;
    arm.newDir = bookDir('Book Three Renamed');
    arm.fired = false;
    arm.n = 0;
    const res = await save(id);
    expect(arm.fired).toBe(true);
    await moveDone.p;
    arm.path = '';
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(existsSync(bookDir('Book Three'))).toBe(false);
    expect(JSON.parse(readFileSync(castPath('Book Three Renamed'), 'utf8')).characters[0].overrideTtsVoices.qwen.name).toBe('qwen-u3');
  });

  it('Start fresh landing while the Save waits for the book-op: the Save sees it unconfirmed and writes that book only', async () => {
    rmSync(join(root, 'books'), { recursive: true, force: true });
    await writeBook('Book One', true);
    await writeBook('Book Two', true);
    const id = await writeBook('Book Three', true); // confirmed when the Save is accepted
    const one = readFileSync(castPath('Book One'), 'utf8');
    const two = readFileSync(castPath('Book Two'), 'utf8');
    const { withBookOp } = await import('../workspace/book-op-lock.js');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = withBookOp(id, async () => {
      entered();
      await held;
    });
    await inside;
    const pending = save(id).then((r) => r);
    await new Promise((r) => setTimeout(r, 400)); // the Save has resolved the series and reached the lock
    const s = JSON.parse(readFileSync(statePath('Book Three'), 'utf8'));
    writeFileSync(statePath('Book Three'), JSON.stringify({ ...s, castConfirmed: false })); // Start fresh
    release();
    await holder;
    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(one);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(two);
    expect(slot('Book Three')).toBe('qwen-u3');
  });

  it('control: a CONFIRMED book still writes the series', async () => {
    rmSync(join(root, 'books'), { recursive: true, force: true });
    await writeBook('Book One', true);
    await writeBook('Book Two', true);
    const id = await writeBook('Book Three', true);
    const res = await save(id);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(slot('Book One')).toBe('qwen-u3');
    expect(slot('Book Two')).toBe('qwen-u3');
    expect(slot('Book Three')).toBe('qwen-u3');
  });
});
