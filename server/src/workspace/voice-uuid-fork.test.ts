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

const U = 'uuid-shared';
const ONE_ID = 'book-one-id';
const TWO_ID = 'book-two-id';
const THREE_ID = 'book-three-id';

function book(title: string, bookId: string, chars: object[]): string {
  const dir = join(root, 'books', 'Author', 'Series', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({
    bookId, manuscriptId: `m_${bookId}`, title, author: 'Author', series: 'Series',
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
  } = await import('./voice-uuid-fork.js'));
});
afterAll(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('scanVoiceHolders (#3992)', () => {
  it('splits other books holding the uuid into DIRECT followers and everyone else', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c' } }]);
    book('Four', 'book-four-id', [{ id: 'c', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c' } }]);
    const s = await scan(two, { id: 'c' }, holdsUuid(U));
    expect(s.followers.map((f) => f.bookId)).toEqual([THREE_ID]);
    expect(s.heldElsewhere).toBe(true); // One, and Four two hops down
    expect([...s.holderBookIds].sort()).toEqual([ONE_ID, 'book-four-id', THREE_ID].sort());
  });

  it('only direct followers hold it: not held elsewhere', async () => {
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
