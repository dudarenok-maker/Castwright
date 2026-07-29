/* Durable guard regression — PUT /:bookId/state slice=cast must never strip a
   designed Qwen voice off a GENERATED character (the 2026-06-05 The Drowning Bell
   incident).

   A generated character stores its bespoke voice in `overrideTtsVoices.qwen`
   with NO `voiceId` (unlike a reused character). The srv-14 denormalise pass
   only fills voices for REUSED characters (it walks `matchedFrom`), so it can't
   protect a generated one. When the analysing→cast-confirm flow persisted a
   voiceless in-memory cast, the PUT overwrote cast.json and erased the designed
   voice. `preserveDesignedVoicesOnCastWrite` (wired ahead of the denormalise
   pass) fills the dropped voice-design fields from the on-disk character.

   Kept in its own fast-tier file (NOT book-state.test.ts, pinned slow) so the
   fixture setup doesn't compound the slow-run hook-timeout pressure. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Preserve Author';
const SERIES = 'Preserve Series';
const TITLE = 'Only Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;

function writeBook(dir: string, id: string, characters: unknown[]): void {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${TITLE}`,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

function onDiskCast(): { characters: Array<Record<string, unknown> & { id: string }> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-preserve-voices-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  /* Berrin — a GENERATED character (no voiceId): her designed voice lives
     only in overrideTtsVoices.qwen. */
  writeBook(bookDir, bookId, [
    {
      id: 'berrin',
      name: 'Berrin',
      role: 'minor',
      color: '#abc',
      voiceState: 'generated',
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-berrin' } },
      voiceStyle: 'a wry, steady woman',
    },
  ]);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('book-state PUT cast — designed-voice preservation (durable strip guard)', () => {
  it('preserves a generated character\'s designed voice when the UI sends a voiceless cast', async () => {
    /* The strip payload: the cast-confirm flow re-derived the roster and lost
       Berrin's voice fields entirely. */
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [{ id: 'berrin', name: 'Berrin', role: 'minor', color: '#abc', voiceState: 'generated' }],
      },
    };
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const berrin = onDiskCast().characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
    expect(berrin.ttsEngine).toBe('qwen');
    expect(berrin.voiceStyle).toBe('a wry, steady woman');
  });

  /* [#1899] — a wholesale cast PUT must never let a client restamp
     voiceUuid or plant a foreign clone-engine storage key with no consent
     check. Berrin has no clone/library voice at all on disk today; the
     attack tries to both restamp her voiceUuid AND assign a coqui slot
     shaped like a real cloned voice's storage key in one request. */
  it('[#1899] rejects a wholesale write that restamps voiceUuid and plants a foreign coqui clone key', async () => {
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [
          {
            id: 'berrin',
            name: 'Berrin',
            role: 'minor',
            color: '#abc',
            voiceState: 'generated',
            voiceUuid: 'attacker-supplied-uuid',
            overrideTtsVoices: {
              qwen: { name: 'qwen-berrin' },
              coqui: { name: 'xtts-victim-uuid', libraryUuid: 'victim-uuid', provenance: 'cloned' },
            },
          },
        ],
      },
    };
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    /* GATE 2 (owner-directed) — a deliberate consent refusal is a 409, not
       the 500 this originally returned: a client's retry/telemetry logic must
       be able to tell "we refused you" from "we broke". */
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/doesn't match/);

    /* Nothing was written — Berrin's on-disk record is untouched, no
       voiceUuid and no foreign coqui slot. */
    const berrin = onDiskCast().characters.find((c) => c.id === 'berrin')!;
    expect(berrin.voiceUuid).toBeUndefined();
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
  });

  it('lets a deliberate re-design overwrite the on-disk voice (incoming wins)', async () => {
    const incoming = {
      slice: 'cast',
      patch: {
        characters: [
          {
            id: 'berrin',
            name: 'Berrin',
            role: 'minor',
            color: '#abc',
            voiceState: 'generated',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'qwen-berrin-v2' } },
          },
        ],
      },
    };
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send(incoming);
    expect(res.status).toBe(204);

    const berrin = onDiskCast().characters.find((c) => c.id === 'berrin')!;
    expect(berrin.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin-v2' } });
  });
});

/* [GATE 2 C-B1] — the erase/replace half of #1899, driven end to end through
   the real route rather than the guard function alone, because the defect was
   that the route's guard CHAIN let it through: `rejectForeignCloneKeys` only
   inspects what a write adds, and `preserveDesignedVoicesOnCastWrite` only
   restores a wholly-absent map, so a present map that dropped or overwrote a
   cloned slot got a 2xx and landed on disk.

   Its own book (and its own cast fixture) so it can't disturb the
   order-dependent describe above, which rewrites the shared book's cast on
   every request. */
describe('book-state PUT cast — a cloned slot survives a wholesale write (C-B1)', () => {
  const CLONE_TITLE = 'Clone Book';
  const clonedSlot = { name: 'xtts-real-person', libraryUuid: 'lib-123', provenance: 'cloned' };
  let cloneBookId: string;
  let cloneBookDir: string;

  function cloneCast(): { characters: Array<Record<string, unknown> & { id: string }> } {
    return JSON.parse(readFileSync(join(cloneBookDir, '.audiobook', 'cast.json'), 'utf8'));
  }

  function seedCast(): void {
    writeBook(cloneBookDir, cloneBookId, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'major',
        color: '#abc',
        voiceState: 'generated',
        ttsEngine: 'coqui',
        overrideTtsVoices: { coqui: { ...clonedSlot } },
      },
    ]);
  }

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    cloneBookId = makeBookId(AUTHOR, SERIES, CLONE_TITLE);
    cloneBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, CLONE_TITLE);
  });

  beforeEach(() => seedCast());

  it('[C-B1] restores the cloned slot when the incoming map omits it, and still 204s', async () => {
    /* The stale-tab shape: the client sends a present map that simply
       doesn't carry the coqui slot the assign route wrote. */
    const res = await request(app)
      .put(`/api/books/${cloneBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'wren',
              name: 'Wren',
              role: 'major',
              color: '#abc',
              voiceState: 'generated',
              overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
            },
          ],
        },
      });
    expect(res.status).toBe(204);

    const wren = cloneCast().characters.find((c) => c.id === 'wren')!;
    /* The marker is still on disk — this is the assertion the defect broke.
       The rest of the write (the qwen slot) landed as sent. */
    expect(wren.overrideTtsVoices).toEqual({ qwen: { name: 'qwen-wren' }, coqui: clonedSlot });
  });

  it('[C-B1] refuses with 409 when the write replaces the cloned slot with a catalogue voice', async () => {
    const res = await request(app)
      .put(`/api/books/${cloneBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'wren',
              name: 'Wren',
              role: 'major',
              color: '#abc',
              voiceState: 'generated',
              overrideTtsVoices: { coqui: { name: 'Ana Florence' } },
            },
          ],
        },
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/consented cloned voice/);

    /* Refused means nothing persisted — not "persisted then patched back". */
    const wren = cloneCast().characters.find((c) => c.id === 'wren')!;
    expect(wren.overrideTtsVoices).toEqual({ coqui: clonedSlot });
  });

  it('[C-B1] still accepts an unchanged round-trip of the same cloned slot', async () => {
    const res = await request(app)
      .put(`/api/books/${cloneBookId}/state`)
      .set('Content-Type', 'application/json')
      .send({
        slice: 'cast',
        patch: {
          characters: [
            {
              id: 'wren',
              name: 'Wren',
              role: 'major',
              color: '#abc',
              voiceState: 'generated',
              description: 'edited',
              overrideTtsVoices: { coqui: { ...clonedSlot } },
            },
          ],
        },
      });
    expect(res.status).toBe(204);

    const wren = cloneCast().characters.find((c) => c.id === 'wren')!;
    expect(wren.overrideTtsVoices).toEqual({ coqui: clonedSlot });
    expect(wren.description).toBe('edited'); // ordinary cast edits still flow
  });
});
