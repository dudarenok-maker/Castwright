/* Integration tests for the voice-override-linked router (plan 122).

   Seeds a small the Hollow Tide series on disk and asserts the keystone behaviour: a
   single approve unifies voiceId + writes the Qwen override across a recurring
   character's whole name/alias group — even when the books never shared a
   voiceId — while respecting notLinkedTo and the old voiceId-key propagation.

   Same lazy-import pattern as the sibling route tests so WORKSPACE_DIR is set
   before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK_A = 'The Hollow Tide';
const BOOK_B = 'The Ebb';
const BOOK_C = 'The Tidewatcher’s Oath';
const OTHER_BOOK = 'A Different Saga';
const STANDALONE = 'A Standalone';

let workspaceRoot: string;
let app: Express;
let bookA: string;
let bookB: string;
let bookC: string;
let otherBookId: string;
let standaloneId: string;

function writeBookOnDisk(
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean } = {},
) {
  const dir = join(workspaceRoot, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
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

function readCharacters(title: string): Array<Record<string, unknown>> {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, title, '.audiobook', 'cast.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> })
    .characters;
}
function findChar(title: string, id: string): Record<string, unknown> | undefined {
  return readCharacters(title).find((c) => c.id === id);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voice-override-linked-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ voiceOverrideLinkedRouter }, { makeBookId }] = await Promise.all([
    import('./voice-override-linked.js'),
    import('../workspace/paths.js'),
  ]);
  bookA = makeBookId(AUTHOR, SERIES, BOOK_A);
  bookB = makeBookId(AUTHOR, SERIES, BOOK_B);
  bookC = makeBookId(AUTHOR, SERIES, BOOK_C);
  otherBookId = makeBookId(AUTHOR, 'A Different Saga', OTHER_BOOK);
  standaloneId = makeBookId(AUTHOR, SERIES, STANDALONE);
  app = express();
  app.use(express.json());
  app.use('/api/books', voiceOverrideLinkedRouter);
});

beforeEach(() => {
  /* Wren under three divergent identities, NO shared voiceId:
       A: id 'wren' (alias "Wren Sparrow")   B: id 'wren-sparrow'
       C: id 'wren' (no alias). */
  writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', aliases: ['Wren Sparrow'], lines: 100 },
    { id: 'marlow', name: 'Marlow', role: 'character', color: 'unset', voiceId: 'v_marlow', lines: 80 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
    { id: 'wren-sparrow', name: 'Wren Sparrow', role: 'character', color: 'unset', lines: 90 },
    { id: 'marlow-halden', name: 'Marlow Halden', role: 'character', color: 'unset', voiceId: 'v_marlow', lines: 60 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_C, bookC, [
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 70 },
  ]);
  writeBookOnDisk(AUTHOR, 'A Different Saga', OTHER_BOOK, otherBookId, [
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 5 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, STANDALONE, standaloneId, [
    { id: 'loner', name: 'Loner', role: 'character', color: 'unset', lines: 9 },
  ], { isStandalone: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callLinked(bookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/${characterId}/voice-override-linked`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/:characterId/voice-override-linked', () => {
  it('unifies voiceId + writes the override across the whole name/alias group', async () => {
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('wren'); // source.voiceId ?? id
    /* All three Wren rows in THIS series are written + unified. */
    const updatedIds = (res.body.updated as Array<{ characterId: string }>).map((u) => u.characterId).sort();
    expect(updatedIds).toEqual(['wren', 'wren', 'wren-sparrow']);

    for (const [title, id] of [
      [BOOK_A, 'wren'],
      [BOOK_B, 'wren-sparrow'],
      [BOOK_C, 'wren'],
    ] as const) {
      const c = findChar(title, id);
      expect(c?.voiceId).toBe('wren');
      expect((c?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('wren-designed');
      expect(c?.ttsEngine).toBe('qwen');
    }
  });

  it('does NOT cross series boundaries (the same-named Wren in another saga is untouched)', async () => {
    await callLinked(bookA, 'wren', { override: { engine: 'qwen', name: 'wren-designed' } });
    const otherPath = join(workspaceRoot, 'books', AUTHOR, 'A Different Saga', OTHER_BOOK, '.audiobook', 'cast.json');
    const other = (JSON.parse(readFileSync(otherPath, 'utf8')) as { characters: Array<Record<string, unknown>> }).characters[0];
    expect(other.overrideTtsVoices).toBeUndefined();
    expect(other.voiceId).toBeUndefined();
  });

  it('respects notLinkedTo — a pair marked intentionally different is skipped', async () => {
    /* Mark A/wren ↮ B/wren-sparrow as different. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        notLinkedTo: [{ bookId: bookB, characterId: 'wren-sparrow' }],
        lines: 100,
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-designed' },
    });
    expect(res.status).toBe(200);
    /* B/wren-sparrow is excluded; C/wren (id-fallback key 'wren' matches
       canonical) still gets it. */
    expect(findChar(BOOK_B, 'wren-sparrow')?.overrideTtsVoices).toBeUndefined();
    expect((findChar(BOOK_C, 'wren')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('wren-designed');
  });

  it('still propagates by shared voiceId across differently-named rows (old behaviour preserved)', async () => {
    const res = await callLinked(bookA, 'marlow', {
      override: { engine: 'qwen', name: 'marlow-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('v_marlow');
    /* B/marlow-halden shares voiceId v_marlow though its name differs. */
    expect((findChar(BOOK_B, 'marlow-halden')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('marlow-designed');
    expect(findChar(BOOK_A, 'marlow')?.voiceId).toBe('v_marlow');
  });

  it('clears the engine map when override is null', async () => {
    await callLinked(bookA, 'wren', { override: { engine: 'qwen', name: 'wren-designed' } });
    const res = await callLinked(bookA, 'wren', { override: null });
    expect(res.status).toBe(200);
    expect(findChar(BOOK_A, 'wren')?.overrideTtsVoices).toBeUndefined();
  });

  it('400s an invalid override body', async () => {
    const res = await callLinked(bookA, 'wren', { override: { engine: 'banjo', name: 'x' } });
    expect(res.status).toBe(400);
  });

  it('404s an unknown book or character', async () => {
    expect((await callLinked('nope', 'wren', { override: null })).status).toBe(404);
    expect((await callLinked(bookA, 'ghost', { override: null })).status).toBe(404);
  });

  it('writes only the source row for a standalone (no series-mates)', async () => {
    const res = await callLinked(standaloneId, 'loner', {
      override: { engine: 'qwen', name: 'loner-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].characterId).toBe('loner');
  });

  it('preserves libraryUuid/provenance on the set path (designed slot)', async () => {
    /* fs-38 Wave 3c Task 4 — the set path used to replace the whole slot with
       a bare {name}, dropping libraryUuid/provenance even for a NON-cloned
       (designed) voice. Copy the spread shape voices.ts:781 already uses. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        overrideTtsVoices: {
          qwen: { name: 'wren-old', libraryUuid: 'lib-designed-1', provenance: 'designed' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-new' },
    });
    expect(res.status).toBe(200);
    const c = findChar(BOOK_A, 'wren');
    const slot = (c?.overrideTtsVoices as Record<string, Record<string, unknown>>)?.qwen;
    expect(slot?.name).toBe('wren-new');
    expect(slot?.libraryUuid).toBe('lib-designed-1');
    expect(slot?.provenance).toBe('designed');
  });

  it('refuses (does not write) a group SET that would replace a cloned slot', async () => {
    /* Wren in book A carries a CONSENTED clone on qwen. A linked set must
       never silently repoint a real person's voice to a different one. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U-CLONE',
        overrideTtsVoices: {
          qwen: { name: 'wren-clone', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'someone-else' },
    });
    /* Book A's write is refused (surfaced as a per-book failure, nothing
       applied there); B/C — the non-cloned siblings — still update. */
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === bookA)).toBe(false);
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookA)).toBe(true);
    const c = findChar(BOOK_A, 'wren');
    const slot = (c?.overrideTtsVoices as Record<string, Record<string, unknown>>)?.qwen;
    /* Unchanged: name, libraryUuid, provenance, AND voiceUuid (the dangerous
       rewrite that would otherwise make a different qwen storage key resolve
       once libraryUuid was gone). */
    expect(slot?.name).toBe('wren-clone');
    expect(slot?.libraryUuid).toBe('lib-clone-1');
    expect(slot?.provenance).toBe('cloned');
    expect(c?.voiceUuid).toBe('U-CLONE');
  });

  /* GATE 2 I-B1 — the same refusal when the clone sits on the OTHER
     clone-capable engine. The SET guard used to test only the engine being
     written, so this passed: the coqui clone survived on disk while the
     write pinned `ttsEngine: 'qwen'`, and `resolveCharacterEngine` then
     routed every one of Wren's lines to the qwen voice instead. Nothing was
     removed or replaced, and the person's voice stopped rendering anyway —
     which is why asserting the slot's survival alone would be a placebo
     here. `ttsEngine` is the assertion that discriminates. */
  it('[I-B1] refuses a group SET on qwen when the character is cloned on COQUI — the retarget mutes the clone', async () => {
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U-CLONE',
        ttsEngine: 'coqui',
        overrideTtsVoices: {
          coqui: { name: 'xtts-lib-clone-1', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'someone-else' },
    });
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === bookA)).toBe(false);
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookA)).toBe(true);

    const c = findChar(BOOK_A, 'wren');
    /* The clone is still the engine that renders — the retarget never landed. */
    expect(c?.ttsEngine).toBe('coqui');
    const slots = c?.overrideTtsVoices as Record<string, Record<string, unknown>>;
    expect(slots?.qwen).toBeUndefined();
    expect(slots?.coqui?.provenance).toBe('cloned');
  });

  it('refuses (does not write) a group SET that would replace a cloned slot with a MALFORMED libraryUuid', async () => {
    /* CRITICAL-2 regression guard: the SET-path guard must test provenance
       ALONE (fail-safe), never the uuid-validating clonedSlotForEngine — a
       cloned slot with a missing/malformed libraryUuid is still a consented
       clone and must still be refused. Before the fix, clonedSlotForEngine
       returned undefined for a slot with no usable libraryUuid, `blocked`
       stayed false, and the dangerous voiceUuid unification + slot overwrite
       proceeded — a real person's voice silently swapped for a stock one. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U-CLONE',
        overrideTtsVoices: {
          // provenance:'cloned' but NO usable libraryUuid (missing).
          qwen: { name: 'wren-clone', provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'someone-else' },
    });
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === bookA)).toBe(false);
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookA)).toBe(true);
    const c = findChar(BOOK_A, 'wren');
    const slot = (c?.overrideTtsVoices as Record<string, Record<string, unknown>>)?.qwen;
    expect(slot?.name).toBe('wren-clone');
    expect(slot?.provenance).toBe('cloned');
    expect(c?.voiceUuid).toBe('U-CLONE');
  });

  it('refuses (does not write) a group SET that would replace a cloned slot with a NON-STRING libraryUuid', async () => {
    /* Same fail-unsafe gap, non-string variant (e.g. a corrupted cast.json
       carrying a number). */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U-CLONE',
        overrideTtsVoices: {
          qwen: { name: 'wren-clone', libraryUuid: 12345, provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'someone-else' },
    });
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === bookA)).toBe(false);
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookA)).toBe(true);
    const c = findChar(BOOK_A, 'wren');
    const slot = (c?.overrideTtsVoices as Record<string, Record<string, unknown>>)?.qwen;
    expect(slot?.name).toBe('wren-clone');
    expect(slot?.provenance).toBe('cloned');
    expect(c?.voiceUuid).toBe('U-CLONE');
  });

  it('refuses (does not write) a group CLEAR that would wipe a cloned slot', async () => {
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        overrideTtsVoices: {
          qwen: { name: 'wren-clone', libraryUuid: 'lib-clone-1', provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', { override: null });
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === bookA)).toBe(false);
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookA)).toBe(true);
    const c = findChar(BOOK_A, 'wren');
    const slot = (c?.overrideTtsVoices as Record<string, Record<string, unknown>>)?.qwen;
    expect(slot?.provenance).toBe('cloned');
    expect(slot?.libraryUuid).toBe('lib-clone-1');
  });

  it('a cloned sibling in ANOTHER book blocks only that book, not the whole group', async () => {
    /* B/wren-sparrow has an independent cloned voice; the source book A/wren
       is a plain designed voice. The set must still reach A and C, and must
       refuse ONLY B. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
      {
        id: 'wren-sparrow',
        name: 'Wren Sparrow',
        role: 'character',
        color: 'unset',
        lines: 90,
        overrideTtsVoices: {
          qwen: { name: 'sparrow-clone', libraryUuid: 'lib-clone-2', provenance: 'cloned' },
        },
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-designed' },
    });
    const updatedIds = (res.body.updated as Array<{ characterId: string }>)
      .map((u) => u.characterId)
      .sort();
    expect(updatedIds).toEqual(['wren', 'wren']); // A + C, not B
    expect(res.body.failed.some((f: { bookId: string }) => f.bookId === bookB)).toBe(true);
    const sparrow = findChar(BOOK_B, 'wren-sparrow');
    const sparrowSlot = (sparrow?.overrideTtsVoices as Record<string, Record<string, unknown>>)
      ?.qwen;
    expect(sparrowSlot?.provenance).toBe('cloned');
    expect(sparrowSlot?.libraryUuid).toBe('lib-clone-2');
  });

  it('converges voiceUuid to canonical on manual unify — both rows get U1', async () => {
    /* Seed: two Wren rows with DIFFERENT voiceUuids; canonical (source) has U1. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U1',
      },
    ]);
    writeBookOnDisk(AUTHOR, SERIES, BOOK_C, bookC, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        lines: 70,
        voiceUuid: 'U2',
      },
    ]);
    /* BOOK_B's wren-sparrow starts with NO voiceUuid; the unify must converge it
       onto the canonical U1 (asserted below), like every other unified row. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
      { id: 'wren-sparrow', name: 'Wren Sparrow', role: 'character', color: 'unset', lines: 90 },
    ]);

    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-uuid-test' },
    });
    expect(res.status).toBe(200);

    /* Canonical source (A/wren, voiceUuid=U1) retains U1. */
    expect(findChar(BOOK_A, 'wren')?.voiceUuid).toBe('U1');
    /* Non-canonical (C/wren, voiceUuid=U2) must be overwritten to U1. */
    expect(findChar(BOOK_C, 'wren')?.voiceUuid).toBe('U1');
    /* Row with no prior voiceUuid (B/wren-sparrow) also gets U1 — canonical uuid
       propagates to all unified rows so the whole group converges on one identity. */
    expect(findChar(BOOK_B, 'wren-sparrow')?.voiceUuid).toBe('U1');
  });

  /* fs-38 Wave 3c, Task 10a — consent-defect fix. The CRITICAL-2 guard above
     only fires on `provenance:'cloned'`; a target character whose slot is
     ABSENT, or `designed` but not backed by the client's planted uuid, was
     unguarded — a client could write `override.name` shaped like
     manifestSlotFor's OWN reserved storage-key prefix ('xtts-'/'qwen-')
     naming a DIFFERENT person's already-consented library uuid, and
     voice-mapping.ts's pickVoiceForEngine would return that raw name
     verbatim as the sidecar's load key once the target's own slot had no
     validated libraryUuid to prefer instead. */
  describe('Task 10a — rejects a planted clone/library storage key', () => {
    it('rejects a planted xtts-<uuid> on a character whose coqui slot is ABSENT', async () => {
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'coqui', name: 'xtts-someone-elses-uuid' },
      });
      expect(res.body.updated).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].error).toMatch(/consented voice/);
      /* Disk untouched — no coqui slot was written. */
      expect(findChar(STANDALONE, 'loner')?.overrideTtsVoices).toBeUndefined();
    });

    it('rejects a planted xtts-<uuid> on a character whose coqui slot is DESIGNED (a different uuid)', async () => {
      writeBookOnDisk(
        AUTHOR,
        SERIES,
        STANDALONE,
        standaloneId,
        [
          {
            id: 'loner',
            name: 'Loner',
            role: 'character',
            color: 'unset',
            lines: 9,
            overrideTtsVoices: {
              coqui: { name: 'xtts-own-uuid', libraryUuid: 'own-uuid', provenance: 'designed' },
            },
          },
        ],
        { isStandalone: true },
      );
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'coqui', name: 'xtts-someone-elses-uuid' },
      });
      expect(res.body.updated).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].error).toMatch(/consented voice/);
      /* Disk untouched — the character's OWN designed slot survives unmolested. */
      const slot = (findChar(STANDALONE, 'loner')?.overrideTtsVoices as Record<string, Record<string, unknown>>)
        ?.coqui;
      expect(slot?.name).toBe('xtts-own-uuid');
      expect(slot?.libraryUuid).toBe('own-uuid');
      expect(slot?.provenance).toBe('designed');
    });

    it('rejects the qwen- equivalent on a character whose qwen slot is ABSENT (defence-in-depth — the qwen render branch ignores name entirely, so this isn\'t a live breach today, but the guard is engine-symmetric on purpose)', async () => {
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'qwen', name: 'qwen-someone-elses-uuid' },
      });
      expect(res.body.updated).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].error).toMatch(/consented voice/);
      expect(findChar(STANDALONE, 'loner')?.overrideTtsVoices).toBeUndefined();
    });

    it('rejects a planted xtts-<uuid> on a character whose coqui slot is DESIGNED with NO libraryUuid (the actually-live legacy-drift shape)', async () => {
      /* MINOR-1 fix-round fixture — provenance:'designed' with an empty/no
         libraryUuid (or a bare libraryUuid with no provenance) is the
         shape libraryVoiceForEngine ALSO reads as "no library slot", so a
         broken guard here really would let the raw planted name pass
         through to the sidecar unlike the "designed, valid own uuid" test
         above (where libraryVoiceForEngine wins regardless of the guard). */
      writeBookOnDisk(
        AUTHOR,
        SERIES,
        STANDALONE,
        standaloneId,
        [
          {
            id: 'loner',
            name: 'Loner',
            role: 'character',
            color: 'unset',
            lines: 9,
            overrideTtsVoices: { coqui: { name: 'xtts-own-uuid', provenance: 'designed' } },
          },
        ],
        { isStandalone: true },
      );
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'coqui', name: 'xtts-someone-elses-uuid' },
      });
      expect(res.body.updated).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].error).toMatch(/consented voice/);
      const slot = (findChar(STANDALONE, 'loner')?.overrideTtsVoices as Record<string, Record<string, unknown>>)
        ?.coqui;
      expect(slot?.name).toBe('xtts-own-uuid');
      expect(slot?.libraryUuid).toBeUndefined();
    });

    it('MAJOR-1 fix-round: rejects a case-varied planted key (XTTS-<uuid> vs the on-disk xtts-<uuid>.pt — NTFS/APFS are case-insensitive)', async () => {
      /* Case-sensitive startsWith would have missed this entirely — 'XTTS-'
         doesn't match a literal 'xtts-' prefix — while the sidecar's
         os.path.isfile still resolves it to the SAME .pt as a lower-case
         key. This is the exact bypass the fix-round review caught. */
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'coqui', name: 'XTTS-someone-elses-uuid' },
      });
      expect(res.body.updated).toHaveLength(0);
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].error).toMatch(/consented voice/);
      expect(findChar(STANDALONE, 'loner')?.overrideTtsVoices).toBeUndefined();
    });

    it('a legitimate write still succeeds: a name matching this write\'s OWN server-derived voiceUuid (the real bespoke-Qwen-propagation shape)', async () => {
      /* Mirrors rebaseline-modal.tsx's Approve step: it writes
         `{engine:'qwen', name: <voiceId returned by designQwenVoice>}` with
         NO libraryUuid at all — voiceMapping's qwen branch (no libraryUuid)
         resolves the storage key from the character's OWN voiceUuid, not
         from `name`, so `qwen-<own voiceUuid>` is always self-consistent,
         never a foreign key. */
      writeBookOnDisk(
        AUTHOR,
        SERIES,
        STANDALONE,
        standaloneId,
        [{ id: 'loner', name: 'Loner', role: 'character', color: 'unset', lines: 9, voiceUuid: 'U-LONER' }],
        { isStandalone: true },
      );
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'qwen', name: 'qwen-U-LONER' },
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toHaveLength(1);
      const c = findChar(STANDALONE, 'loner');
      expect((c?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('qwen-U-LONER');
      expect(c?.voiceUuid).toBe('U-LONER');
    });

    it('a legitimate write still succeeds: an ordinary display name with no reserved-prefix shape is untouched', async () => {
      /* The common case — 'Damien Black' (a catalog name) doesn't start with
         'xtts-' or 'qwen-', so the new guard never inspects it at all. */
      const res = await callLinked(standaloneId, 'loner', {
        override: { engine: 'coqui', name: 'Damien Black' },
      });
      expect(res.status).toBe(200);
      expect((findChar(STANDALONE, 'loner')?.overrideTtsVoices as Record<string, { name: string }>)?.coqui?.name).toBe(
        'Damien Black',
      );
    });
  });
});

/* #1981 — `applyToBook` is the per-book read-modify-write helper (already
   exported for direct-drive tests — see its own header comment). Two
   concurrent calls for DIFFERENT characters in the SAME book race that
   book's cast.json. Unlocked, both calls' readJson resolve before either
   writeJsonAtomic lands, so the later write replays a `characters` snapshot
   taken before the earlier write happened and silently drops it. Driving the
   helper directly (not the route) keeps this test independent of the
   series-discovery scan's own timing. */
describe('#1981 — two applyToBook calls for one book overlap', () => {
  it('keeps both overrides when two applyToBook calls for one book overlap', async () => {
    const { applyToBook } = await import('./voice-override-linked.js');
    const bookADir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_A);

    /* `gemini` is not a clone-capable engine (CLONE_CAPABLE_ENGINES =
       {qwen, coqui}) — sidesteps the Task 10a reserved-prefix guard, which
       is orthogonal to what this test is pinning. */
    await Promise.all([
      applyToBook(bookADir, ['wren'], 'wren', undefined, { engine: 'gemini', name: 'Wren Voice X' }),
      applyToBook(bookADir, ['marlow'], 'v_marlow', undefined, {
        engine: 'gemini',
        name: 'Marlow Voice Y',
      }),
    ]);

    const wren = findChar(BOOK_A, 'wren');
    const marlow = findChar(BOOK_A, 'marlow');
    expect((wren?.overrideTtsVoices as Record<string, { name: string }>)?.gemini?.name).toBe(
      'Wren Voice X',
    );
    expect((marlow?.overrideTtsVoices as Record<string, { name: string }>)?.gemini?.name).toBe(
      'Marlow Voice Y',
    );
  });
});

/* #2292 (owner decision) — a lock timeout on ONE series-mate's write reports
 * contention, not a broken cast.
 *
 * Same decision, same shape and same two directions as the sibling
 * `cast-series-patch` fixtures: the per-book `failed` entry stays (the other
 * books' writes must still land), and only the REASON changes, because a
 * `LockAcquisitionTimeoutError` says nothing about the book it is reported
 * against. The second test is the half that reddens if the route rewrote every
 * failure reason instead of just this class.
 *
 * `withCastLock` is the seam (`applyToBook` takes it per book) rather than a
 * genuinely contended lock — the real budget is 10s, vitest's testTimeout 15s.
 */
describe('voice-override-linked — per-item reason on a lock timeout (#2292)', () => {
  async function assignWithThrowOnBookC(toThrow: unknown) {
    const castLock = await import('../workspace/cast-lock.js');
    const original = castLock.withCastLock;
    const spy = vi
      .spyOn(castLock, 'withCastLock')
      .mockImplementation(async <T,>(dir: string, fn: () => Promise<T>): Promise<T> => {
        if (dir.includes(BOOK_C)) throw toThrow;
        return original(dir, fn) as Promise<T>;
      });
    try {
      return await callLinked(bookA, 'wren', {
        override: { engine: 'qwen', name: 'wren-designed' },
      });
    } finally {
      spy.mockRestore();
    }
  }

  it('reports contention for the contended book and still writes the others', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_ITEM_REASON } = await import(
      '../workspace/file-lock.js'
    );
    const res = await assignWithThrowOnBookC(
      new LockAcquisitionTimeoutError('cast:/w/book-c', 10_000),
    );

    expect(res.status).toBe(207);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].bookId).toBe(bookC);
    expect(res.body.failed[0].error).toBe(LOCK_CONTENTION_ITEM_REASON);
    expect(res.body.failed[0].error).not.toContain('withKeyLock');

    /* Not escalated: the other two books took the override. */
    expect(
      (res.body.updated as Array<{ bookId: string }>).map((u) => u.bookId).sort(),
    ).toEqual([bookA, bookB].sort());
    expect(
      (findChar(BOOK_A, 'wren')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name,
    ).toBe('wren-designed');
  });

  it('an ordinary error at the same site keeps its own message', async () => {
    const res = await assignWithThrowOnBookC(new Error('simulated disk-full'));

    expect(res.status).toBe(207);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].error).toBe('simulated disk-full');
  });
});
