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

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* #1981 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the race test at
   the bottom of this file can deterministically intercept book-state.ts's
   OWN `readJson` call (bound at book-state.ts's own module-load time,
   before any runtime spy could attach to it). Defaults to a plain
   passthrough — every other test in this file behaves exactly as if this
   mock weren't here — so only the one race test below overrides
   `mockImplementation` for the duration of its own `it`, then restores it. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

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

  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
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

/* #1981 — book-state.ts's cast slice writes `body.patch` wholesale and is
   last-writer-wins BY CONTRACT, so "two PUTs, different characters, both
   survive" is the wrong shape to test here (it stays red even after the
   lock — Task 11 reasons the same thing for its own site). What the lock
   actually protects is the clone-consent guards inside `preserveDesignedVoices`
   (this file's whole point, see the header comment above): a cast PUT whose
   patch omits a character's `overrideTtsVoices`, raced against
   POST /voice-library/:voiceUuid/assign planting one on the SAME character.
   Unlocked, the PUT's `preserveDesignedVoices` read can land BEFORE assign's
   write, so `preserveDesignedVoicesOnCastWrite`'s existingChars snapshot has
   nothing to restore — the PUT's later write (still using that stale
   snapshot) overwrites cast.json with no override, silently erasing the one
   assign just planted. Locked, the PUT's read is inside the same cast lock
   assign takes, so it either fully precedes or fully follows assign's own
   write — never straddles it. */
describe('book-state PUT cast — #1981 race: stale cast PUT vs concurrent /assign', () => {
  const RACE_TITLE = 'Race Assign Book';
  const RACE_VOICE_UUID = 'race-voice-1';
  let raceBookId: string;
  let raceBookDir: string;
  let vl: typeof import('../workspace/voice-library.js');

  function raceCast(): { characters: Array<Record<string, unknown> & { id: string }> } {
    return JSON.parse(readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'));
  }

  beforeAll(async () => {
    const [{ makeBookId }, { voiceLibraryRouter }, voiceLibMod] = await Promise.all([
      import('../workspace/paths.js'),
      import('./voice-library.js'),
      import('../workspace/voice-library.js'),
    ]);
    vl = voiceLibMod;
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_TITLE);
    raceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RACE_TITLE);
    /* Same shared `app` the rest of this file uses — voice-library only
       answers under /api/voice-library, so this can't shadow the book-state
       routes the other describes exercise. */
    app.use('/api/voice-library', voiceLibraryRouter);
  });

  beforeEach(async () => {
    writeBook(raceBookDir, raceBookId, [
      { id: 'nova', name: 'Nova', role: 'minor', color: '#abc', voiceState: 'generated' },
    ]);
    await vl.writeEntry({
      voiceUuid: RACE_VOICE_UUID,
      name: 'Race Voice',
      provenance: 'imported',
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  /* This pairing (a bespoke book-state PUT vs. the much heavier /assign route
     — readEntry + consent checks + findBookByBookId before it ever touches
     cast.json) has asymmetric preambles, so a bare `Promise.all` of two
     supertest calls doesn't reliably straddle the two writes the way the
     self-vs-self races elsewhere in this sweep do (those keep both sides'
     preambles symmetric — see cast-series-patch's and cast-aliases' race
     tests — which isn't an option for two different ROUTES). Instead,
     deterministically SCRIPT the interleaving: intercept the first `readJson`
     call against this book's cast.json (PUT's own, inside
     `preserveDesignedVoices`) and hold its resolution open behind a
     manually-released gate — real bytes are read now (so PUT's read
     genuinely happens-before /assign's write, matching the bug's
     precondition), only the JS-visible resolution is delayed. /assign then
     gets a generous, one-directional head start to either complete fully
     (unlocked — the bug window) or queue behind PUT's held lock (locked —
     the fix): either way the outcome doesn't depend on tuning a tight timing
     window, only on "long enough", which a generous setTimeout satisfies
     without flaking.

     supertest requests are LAZY — `request(app).post(...)` does not actually
     dispatch until the Test object is awaited/`.then()`'d (see the repo's own
     `r_supertest_request` note). Merely constructing `assignPromise` and
     holding it in a variable does NOT start it; a `.catch(() => {})` right
     after construction forces real dispatch now, decoupled from when the
     result is actually awaited below — without it, /assign's request doesn't
     even reach the network until the final `Promise.all`, by which point the
     gate has long since released and there is nothing left to race. */
  it('#1981 — a stale cast PUT does not erase a concurrently /assign-planted voice', async () => {
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const raceCastPath = castJsonPath(raceBookDir);
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === raceCastPath) {
        intercepted = true;
        const value = await actual.readJson(path); // real read, now — happens-before /assign's write
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let resPut: request.Response;
    let resAssign: request.Response;
    try {
      const putPromise = request(app)
        .put(`/api/books/${raceBookId}/state`)
        .set('Content-Type', 'application/json')
        .send({
          slice: 'cast',
          patch: {
            characters: [
              { id: 'nova', name: 'Nova', role: 'minor', color: '#abc', voiceState: 'generated' },
            ],
          },
        });
      putPromise.catch(() => {}); // force dispatch now (see header comment)
      // Let PUT reach (and get stuck behind) the intercepted read.
      await new Promise((r) => setTimeout(r, 20));
      expect(intercepted).toBe(true);

      const assignPromise = request(app)
        .post(`/api/voice-library/${RACE_VOICE_UUID}/assign`)
        .send({ bookId: raceBookId, characterId: 'nova' });
      assignPromise.catch(() => {}); // force dispatch now (see header comment)
      // Generous head start: completes fully when unlocked, queues harmlessly
      // behind PUT's held lock when locked. Not a tight window either way.
      await new Promise((r) => setTimeout(r, 50));

      released();
      [resPut, resAssign] = await Promise.all([putPromise, assignPromise]);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
    }
    expect(resPut.status).toBe(204);
    expect(resAssign.status).toBe(200);

    const nova = raceCast().characters.find((c) => c.id === 'nova')!;
    expect((nova.overrideTtsVoices as Record<string, { name: string }> | undefined)?.qwen?.name).toBe(
      `qwen-${RACE_VOICE_UUID}`,
    );
  });
});
