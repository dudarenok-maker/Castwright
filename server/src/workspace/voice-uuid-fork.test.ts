import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mod = typeof import('./voice-uuid-fork.js');
let root: string;
let scan: Mod['scanVoiceHolders'];
let onDecline: Mod['mustSeparateOnDecline'];
let onDesign: Mod['mustSeparateOnDesign'];
let holdsUuid: Mod['holdsUuid'];
let holdsLegacyKey: Mod['holdsLegacyKey'];
let voiceHeldBy: Mod['voiceHeldBy'];
let namedQwenVoices: Mod['namedQwenVoices'];
let storageKeyHolderBookIds: Mod['storageKeyHolderBookIds'];
let dropLinkedVariants: Mod['dropLinkedVariants'];

const U = 'uuid-shared';
const ONE_ID = 'book-one-id';
const TWO_ID = 'book-two-id';
const THREE_ID = 'book-three-id';

function book(title: string, bookId: string, chars: object[], series = 'Series'): string {
  const dir = join(root, 'books', 'Author', series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({
    bookId, manuscriptId: `m_${bookId}`, title, author: 'Author', series,
    seriesPosition: 1, isStandalone: false, manuscriptFile: 'manuscript.txt',
    castConfirmed: true, chapters: [], language: 'en', coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
  return dir;
}
const tornCast = (dir: string) => writeFileSync(join(dir, '.audiobook', 'cast.json'), '{"characters":[');

function reset() {
  rmSync(join(root, 'books'), { recursive: true, force: true });
  mkdirSync(join(root, 'books'), { recursive: true });
}
const empty = { followers: [], heldElsewhere: false, holderBookIds: new Set<string>(), unreadableDirs: [] };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'voice-uuid-fork-test-'));
  process.env.WORKSPACE_DIR = root;
  ({
    scanVoiceHolders: scan,
    mustSeparateOnDecline: onDecline,
    mustSeparateOnDesign: onDesign,
    holdsUuid,
    holdsLegacyKey,
    voiceHeldBy,
    namedQwenVoices,
    storageKeyHolderBookIds,
    dropLinkedVariants,
  } = await import('./voice-uuid-fork.js'));
});
afterAll(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('scanVoiceHolders (#3992)', () => {
  it('splits other books holding the uuid into the chain that leads down to X (any depth) and everyone else', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    book('Four', 'book-four-id', [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers.map((f) => f.bookId)).toEqual([THREE_ID, 'book-four-id']); // breadth-first order
    expect(s.heldElsewhere).toBe(true); // One
    expect([...s.holderBookIds]).toEqual([ONE_ID]); // followers move with X: never holders (P10-1)
  });

  it('P10-1: a row in the declined book (fromBookId, or on declinedVoiceFrom) is never a follower; it cuts a cycle and holds the voice', async () => {
    reset();
    /* One <-> Two, and One -> Three -> Two: both cycles run through One. */
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c' } }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c' } }]);
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    const unmarked = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(unmarked.followers.map((f) => f.bookId)).toEqual([THREE_ID, ONE_ID]); // the cycle, without a decline
    for (const s of [
      await scan(two, { id: 'c' }, holdsUuid(U), ONE_ID),
      await scan(two, { id: 'c', declinedVoiceFrom: [ONE_ID] }, holdsUuid(U)),
    ]) {
      expect(s.followers.map((f) => f.bookId)).toEqual([THREE_ID]);
      expect(s.heldElsewhere).toBe(true);
      expect([...s.holderBookIds]).toEqual([ONE_ID]);
    }
  });

  it('a hop resolves through the MIDDLE book’s id history; a cycle terminates; a row off the voice cuts the chain', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: 'book-four-id', characterId: 'c' } }]);
    const three = book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    writeFileSync(join(three, '.audiobook', 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: { 'old-c3': 'c3' } }));
    book('Four', 'book-four-id', [
      { id: 'c', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'old-c3' } },
      { id: 'self', voiceUuid: U, matchedFrom: { bookId: 'book-four-id' } }, // names itself
    ]);
    book('Five', 'book-five-id', [{ id: 'c', voiceUuid: 'elsewhere', matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    book('Six', 'book-six-id', [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: 'book-five-id', characterId: 'c' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers.map((f) => `${f.bookId}/${f.characterId}`)).toEqual([`${THREE_ID}/c3`, 'book-four-id/c']);
    expect(s.heldElsewhere).toBe(true); // Four's `self`, and Six behind the row that left
  });

  it('only followers hold it: not held elsewhere', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers).toHaveLength(1);
    expect(s.heldElsewhere).toBe(false);
  });

  it('a link that names another character, or no book (manual Assign), is no follower', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }, { id: 'other' }]);
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'other' } }]);
    book('Four', 'book-four-id', [{ id: 'c', voiceUuid: U, matchedFrom: { bookTitle: 'Two' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers).toEqual([]);
    expect(s.heldElsewhere).toBe(true);
  });

  it('a link with no characterId names the row with the same id; a retired id still resolves', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }]);
    mkdirSync(join(two, '.audiobook'), { recursive: true });
    writeFileSync(
      join(two, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { 'old-c': 'c' } }),
    );
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID } }]);
    book('Four', 'book-four-id', [{ id: 'c4', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'old-c' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers.map((f) => f.bookId).sort()).toEqual(['book-four-id', THREE_ID].sort());
  });

  it('a same-book sibling on the uuid is not "elsewhere"', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }, { id: 'd', voiceUuid: U }]);
    expect((await scan(two, { id: 'c' }, holdsUuid(U))).heldElsewhere).toBe(false);
  });

  it('the legacy key: a no-uuid row on the same voiceId ?? id holds it; one with a uuid does not', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceId: 'v' }]);
    book('Three', THREE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'x' }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceId: 'v' }]);
    const s = await scan(two, { id: 'c' }, holdsLegacyKey('v'));
    expect([...s.holderBookIds]).toEqual([ONE_ID]);
    expect(voiceHeldBy({ id: 'c', voiceId: 'v' })({ id: 'z', voiceId: 'v' })).toBe(true);
    expect(voiceHeldBy({ id: 'c', voiceUuid: U })({ id: 'z', voiceUuid: U })).toBe(true);
  });

  it('a book it cannot read is reported, never thrown', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }]);
    tornCast(one);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.unreadableDirs).toEqual([resolve(one)]);
    expect(s.heldElsewhere).toBe(false);
  });
});

describe('mustSeparateOnDecline (#3992 — the decline-time invariant)', () => {
  it('a row with no uuid always separates (a series mint would move the earlier legacy key)', () => {
    expect(onDecline({}, empty, ONE_ID)).toBe(true);
  });
  it('a uuid held by a non-follower in another book separates', () => {
    expect(onDecline({ voiceUuid: U }, { ...empty, heldElsewhere: true }, ONE_ID)).toBe(true);
  });
  it('a uuid only its followers (or nobody) hold stays', () => {
    expect(onDecline({ voiceUuid: U }, empty, ONE_ID)).toBe(false);
  });
  it('a book that cannot be read separates (copying writes no other book’s file)', () => {
    expect(onDecline({ voiceUuid: U }, { ...empty, unreadableDirs: ['x'] }, ONE_ID)).toBe(true);
  });
  it('a repeated decline of a row already off the voice it declined is a no-op, whoever holds its own voice now', () => {
    const row = { voiceUuid: 'own', declinedVoiceFrom: [ONE_ID], declinedVoiceUuids: [U] };
    expect(onDecline(row, { ...empty, unreadableDirs: ['x'] }, ONE_ID)).toBe(false);
    expect(onDecline(row, { ...empty, heldElsewhere: true }, ONE_ID)).toBe(false);
    // ...but a decline of a DIFFERENT book is a new decline
    expect(onDecline(row, { ...empty, unreadableDirs: ['x'] }, TWO_ID)).toBe(true);
    // ...and a row still on a voice it declined is not "already separated"
    expect(onDecline({ ...row, voiceUuid: U }, { ...empty, heldElsewhere: true }, ONE_ID)).toBe(true);
  });
});

describe('mustSeparateOnDesign (#3992 — rows declined before the route separated them)', () => {
  it('no marker never separates, whatever else holds the voice', () => {
    expect(onDesign({ voiceUuid: U }, { ...empty, heldElsewhere: true, holderBookIds: new Set([ONE_ID]) })).toBe(false);
    expect(onDesign({}, empty)).toBe(false);
  });
  it('a marked row with no uuid separates', () => {
    expect(onDesign({ declinedVoiceFrom: [ONE_ID] }, empty)).toBe(true);
  });
  it('a uuid on its own declined list separates while another book holds it, or a book is unreadable', () => {
    const row = { voiceUuid: U, declinedVoiceFrom: [TWO_ID], declinedVoiceUuids: [U] };
    expect(onDesign(row, { ...empty, heldElsewhere: true })).toBe(true);
    expect(onDesign(row, { ...empty, unreadableDirs: ['x'] })).toBe(true);
    expect(onDesign(row, empty)).toBe(false);
  });
  it('otherwise only a readable declined book holding the uuid separates it', () => {
    const row = { voiceUuid: U, declinedVoiceFrom: [ONE_ID] };
    expect(onDesign(row, { ...empty, heldElsewhere: true, holderBookIds: new Set([ONE_ID]) })).toBe(true);
    expect(onDesign(row, { ...empty, heldElsewhere: true, holderBookIds: new Set([THREE_ID]) })).toBe(false);
  });
  it('a row the route already separated (its uuid is not a declined one) never separates again, however its chain grows', () => {
    const row = { voiceUuid: 'own', declinedVoiceFrom: [ONE_ID], declinedVoiceUuids: [U] };
    expect(onDesign(row, { ...empty, heldElsewhere: true, holderBookIds: new Set([THREE_ID, 'book-four-id']), unreadableDirs: ['x'] })).toBe(false);
  });
});

describe('namedQwenVoices (#3992 P10-2, #4026)', () => {
  const angry = (name: string) => ({ overrideTtsVoices: { qwen: { name: 'base', variants: { angry: { name } } } } });
  const names = async () => [...((await namedQwenVoices()) ?? new Set(['<null>']))].sort();
  it('names a variant by its stored name, whatever key, link or marker the row has', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: U, ...angry('stored-elsewhere') }]);
    /* #4026 — an unforked declined row and the book it declined share one uuid */
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v', voiceUuid: U, declinedVoiceFrom: [ONE_ID] }]);
    expect(await names()).toEqual(['base', `qwen-${U}`, `qwen-${U}__angry`, 'stored-elsewhere']);
  });
  it("names the render path's derived key: a uuid row's own, a legacy row's legacy key, never a uuid row's legacy key", async () => {
    reset();
    book('One', ONE_ID, [
      { id: 'c', voiceId: 'v', voiceUuid: U, ...angry('x') },
      { id: 'd', voiceId: 'w', ...angry('y') },
    ]);
    const n = await names();
    expect(n).toContain(`qwen-${U}__angry`);
    expect(n).toContain('qwen-w__angry'); // no uuid: the legacy key is the render key
    expect(n).not.toContain('qwen-v__angry'); // a uuid row never reads its legacy key
    expect(n).not.toContain(`qwen-${U}__sad`); // no sad slot
  });
  it('is null when a book cannot be read', async () => {
    reset();
    const dir = book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: U }]);
    expect(await names()).toEqual([`qwen-${U}`]);
    tornCast(dir);
    expect(await namedQwenVoices()).toBeNull();
  });
});

describe('storageKeyHolderBookIds (#4040)', () => {
  const S = { author: 'Author', series: 'Series' };
  const FOUR_ID = 'book-four-id';
  it('H1: the other books of the series with a row on the key, not those without', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Three', THREE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u3' }]);
    expect(await storageKeyHolderBookIds(one, 'qwen-u1', S)).toEqual([TWO_ID]);
  });
  it('H2: a legacy row (no uuid) is found by its legacy key', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceId: 'v_wren' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v_wren' }]);
    expect(await storageKeyHolderBookIds(one, 'qwen-v_wren', S)).toEqual([TWO_ID]);
  });
  it('H3: a book of another series is excluded under a series filter, included without one', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Four', FOUR_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }], 'Other');
    expect(await storageKeyHolderBookIds(one, 'qwen-u1', S)).toEqual([TWO_ID]);
    expect((await storageKeyHolderBookIds(one, 'qwen-u1')).sort()).toEqual([FOUR_ID, TWO_ID]);
  });
  it('H4: the self book never appears', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u9' }]);
    expect(await storageKeyHolderBookIds(one, 'qwen-u1', S)).toEqual([]);
  });
  it('H5: a row separated onto its own uuid is not a holder of the old key', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u1' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v', voiceUuid: 'u-sep' }]);
    expect(await storageKeyHolderBookIds(one, 'qwen-u1', S)).toEqual([]);
  });
});

describe('dropLinkedVariants (#4040)', () => {
  const V = { angry: { name: 'qwen-u1__angry' } };
  const row = (id: string, extra: object, qwen: { name?: string; libraryUuid?: string; provenance?: string; variants?: unknown } = { name: 'qwen-u1', variants: V }) => ({
    id, voiceId: 'v', voiceUuid: 'u1', overrideTtsVoices: { qwen }, ...extra,
  });
  it('D1: every row on the key loses its variants and keeps its name', () => {
    const cast = { characters: [row('a', {}), row('b', {})] };
    const out = dropLinkedVariants(cast, 'qwen-u1');
    expect(out.changed).toBe(true);
    for (const c of out.cast.characters) {
      expect(c.overrideTtsVoices?.qwen).toEqual({ name: 'qwen-u1' });
      expect('variants' in (c.overrideTtsVoices?.qwen ?? {})).toBe(false);
    }
  });
  it('D2: a row on another voice keeps its variants', () => {
    const cast = { characters: [row('a', {}), row('b', { voiceUuid: 'u2' }, { variants: V })] };
    const out = dropLinkedVariants(cast, 'qwen-u1');
    expect(out.cast.characters[1].overrideTtsVoices?.qwen?.variants).toEqual(V);
    expect(out.cast.characters[0].overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
  it('D3: a row on a separated uuid keeps its variants', () => {
    const cast = { characters: [row('a', { voiceUuid: 'u-sep' }, { name: 'qwen-u-sep', variants: V })] };
    const out = dropLinkedVariants(cast, 'qwen-u1');
    expect(out.changed).toBe(false);
    expect(out.cast.characters[0].overrideTtsVoices?.qwen?.variants).toEqual(V);
  });
  it('D4: cloned and library rows keep their variants', () => {
    const cast = {
      characters: [
        row('a', {}, { name: 'qwen-u1', provenance: 'cloned', variants: V }),
        row('b', {}, { name: 'qwen-u1', libraryUuid: 'lib-1', variants: V }),
      ],
    };
    const out = dropLinkedVariants(cast, 'qwen-u1');
    expect(out.changed).toBe(false);
    expect(out.cast.characters[0].overrideTtsVoices?.qwen?.variants).toEqual(V);
    expect(out.cast.characters[1].overrideTtsVoices?.qwen?.variants).toEqual(V);
  });
  it('D5: nothing to drop returns the same cast object', () => {
    const cast = { characters: [row('a', {}, { name: 'qwen-u1' }), row('b', {}, { name: 'qwen-u1', variants: {} })] };
    const out = dropLinkedVariants(cast, 'qwen-u1');
    expect(out.changed).toBe(false);
    expect(out.cast).toBe(cast);
  });
  it('D6: a legacy row (no uuid) is reset for the legacy key', () => {
    const cast = {
      characters: [{ id: 'c', voiceId: 'v_wren', overrideTtsVoices: { qwen: { variants: V } } }],
    };
    const out = dropLinkedVariants(cast, 'qwen-v_wren');
    expect(out.changed).toBe(true);
    expect(out.cast.characters[0].overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
});
