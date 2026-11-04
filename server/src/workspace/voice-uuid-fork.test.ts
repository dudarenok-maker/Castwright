import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

let root: string;
let shouldFork: typeof import('./voice-uuid-fork.js').shouldForkSharedVoiceUuid;
let shouldMintApart: typeof import('./voice-uuid-fork.js').shouldMintApartFromLegacyKey;
let findFollowers: typeof import('./voice-uuid-fork.js').findLinkFollowers;
let decide: typeof import('./voice-uuid-fork.js').decideSharedVoiceDesign;
let scanFollowers: typeof import('./voice-uuid-fork.js').scanLinkFollowers;

const U = 'uuid-shared';
const ONE_ID = 'book-one-id';
const TWO_ID = 'book-two-id';
const DECLINED = [ONE_ID];

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

function reset() {
  rmSync(join(root, 'books'), { recursive: true, force: true });
  mkdirSync(join(root, 'books'), { recursive: true });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'voice-uuid-fork-test-'));
  process.env.WORKSPACE_DIR = root;
  ({
    shouldForkSharedVoiceUuid: shouldFork,
    shouldMintApartFromLegacyKey: shouldMintApart,
    findLinkFollowers: findFollowers,
    scanLinkFollowers: scanFollowers,
    decideSharedVoiceDesign: decide,
  } = await import('./voice-uuid-fork.js'));
});
afterAll(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('shouldForkSharedVoiceUuid (#3992)', () => {
  it('forks when Book Two has no matchedFrom and Book One holds the uuid', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(true);
  });

  it('does not fork a row nobody declined: no marker means no fork even with a holder and no link', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U })).toBe(false);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: [] })).toBe(false);
  });

  it('does not fork when Book Two has a matchedFrom to Book One', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const mf = { bookId: ONE_ID, characterId: 'c1', bookTitle: 'One', confidence: 0.9 };
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, matchedFrom: mf, declinedVoiceFrom: DECLINED })).toBe(false);
  });

  it('does not fork when Book Two has a bookId-less matchedFrom (manual Assign)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const mf = { bookTitle: 'One', confidence: 1 };
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, matchedFrom: mf, declinedVoiceFrom: DECLINED })).toBe(false);
  });

  it('source side: Book One does not fork while Book Two links to it', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c1' } },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(false);
  });

  it('a bookId-less link (manual Assign) is not a follower, so it counts as a holder and the row forks', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', 'book-three-id', [{ id: 'c3', voiceUuid: U, matchedFrom: { bookTitle: 'Two' } }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(true);
  });

  it('forks when the only holder links to a different character id of Book Two', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }, { id: 'c9' }]);
    book('Three', 'book-three-id', [
      { id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c9' } },
    ]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: ['book-three-id'] })).toBe(true);
  });

  it('does not fork a row that already left the declined voice, however long the chain below it', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: 'u-one' }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', 'book-three-id', [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    book('Four', 'book-four-id', [{ id: 'c4', voiceUuid: U, matchedFrom: { bookId: 'book-three-id', characterId: 'c3' } }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED, declinedVoiceUuids: ['u-one'] })).toBe(false);
  });

  it('does not fork for a sole holder or a character without a uuid', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c2', voiceUuid: 'other' }]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(false);
    expect(await shouldFork(one, { id: 'c1', declinedVoiceFrom: DECLINED })).toBe(false);
  });

  it('a same-book sibling with the same uuid is not a holder', async () => {
    reset();
    const one = book('One', ONE_ID, [
      { id: 'c1', voiceUuid: U },
      { id: 'c1b', voiceUuid: U },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(false);
  });
  it('source side: a link that names a RETIRED id of this character still protects it', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    writeFileSync(
      join(one, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { c1_old: 'c1' } }),
    );
    book('Two', TWO_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c1_old' } },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(false);
  });

  it('a declined book whose cast.json cannot be read refuses the design, never forks (pass 8)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const one = book('One', ONE_ID, []);
    writeFileSync(join(one, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    const still = { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] };
    expect(await shouldFork(two, still)).toBe(false);
    expect(await decide(two, still)).toEqual({ kind: 'refuse', message: expect.stringContaining('could not be read') });
    writeFileSync(join(one, '.audiobook', 'cast.json'), JSON.stringify({ characters: [{ id: 'c1', voiceUuid: U }] }));
    expect(await shouldFork(two, still)).toBe(true);
  });

  it('an unrelated book with an unreadable cast.json or state.json neither forks nor refuses a row (pass 8)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: 'u-one' }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    const worse = book('Worse', 'worse-id', [{ id: 'c8' }]);
    writeFileSync(join(worse, '.audiobook', 'state.json'), '{"bookId":');
    const forked = { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] };
    expect(await shouldFork(two, forked)).toBe(false);
    expect(await decide(two, forked)).toEqual({ kind: 'proceed' });
  });

  it('the stored declinedVoiceUuids alone never forks a row (pass 8)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: 'u-one' }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', 'book-three-id', [{ id: 'c3', voiceUuid: U }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] })).toBe(false);
  });

  it('a row that already left the declined voice is not re-forked by an unreadable book (pass 3)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: 'u_own' }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    const forked = { id: 'c2', voiceUuid: 'u_own', declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] };
    expect(await shouldFork(two, forked)).toBe(false);
    // a readable earlier book holding the SAME uuid still forks it
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: 'u_own' }]);
    expect(await shouldFork(two, forked)).toBe(true);
  });

  it('an unreadable book never makes a row nobody declined fork', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U })).toBe(false);
  });
});

describe('shouldMintApartFromLegacyKey (#3992)', () => {
  const slot = { qwen: { name: 'qwen-v_x' } };
  const x = { id: 'c2', voiceId: 'v_x', overrideTtsVoices: slot, declinedVoiceFrom: DECLINED };

  it('true: no uuid, no link, both designed at the shared legacy key', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceId: 'v_x', overrideTtsVoices: slot }]);
    const two = book('Two', TWO_ID, [x]);
    expect(await shouldMintApart(two, x)).toBe(true);
  });

  it('false: a row nobody declined shares the legacy key by design (no marker)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceId: 'v_x', overrideTtsVoices: slot }]);
    const two = book('Two', TWO_ID, [x]);
    expect(await shouldMintApart(two, { ...x, declinedVoiceFrom: undefined })).toBe(false);
  });

  it('false: the row itself has a link, a uuid, or no designed slot', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceId: 'v_x', overrideTtsVoices: slot }]);
    const two = book('Two', TWO_ID, [x]);
    expect(await shouldMintApart(two, { ...x, matchedFrom: { bookId: ONE_ID } })).toBe(false);
    expect(await shouldMintApart(two, { ...x, voiceUuid: 'u' })).toBe(false);
    expect(await shouldMintApart(two, { id: 'c2', voiceId: 'v_x' })).toBe(false);
  });

  it('false: the other book has a uuid, no designed slot, or another voiceId', async () => {
    reset();
    book('One', ONE_ID, [
      { id: 'c1', voiceId: 'v_x', voiceUuid: 'u', overrideTtsVoices: slot },
      { id: 'c3', voiceId: 'v_x' },
      { id: 'c4', voiceId: 'v_y', overrideTtsVoices: slot },
    ]);
    const two = book('Two', TWO_ID, [x]);
    expect(await shouldMintApart(two, x)).toBe(false);
  });

  it('true: an unreadable other book is a possible holder, the same reading as the uuid fork (pass-2 U)', async () => {
    reset();
    const two = book('Two', TWO_ID, [x]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    expect(await shouldMintApart(two, x)).toBe(true);
    expect(await shouldMintApart(two, { ...x, declinedVoiceFrom: undefined })).toBe(false);
  });

  it('true: a bookId-less matchedFrom elsewhere is a holder, not a link back to this row (pass-2 L)', async () => {
    reset();
    const two = book('Two', TWO_ID, [x]);
    book('One', ONE_ID, [{ id: 'c1', voiceId: 'v_x', overrideTtsVoices: slot }]);
    book('Three', 'book-three-id', [
      { id: 'c3', voiceId: 'v_x', overrideTtsVoices: slot, matchedFrom: { bookTitle: 'Book Two', confidence: 0.9 } },
    ]);
    expect(await shouldMintApart(two, x)).toBe(true);
    // and on its own it is still a holder: with nothing else sharing the key the row mints apart
    reset();
    const two2 = book('Two', TWO_ID, [x]);
    book('Three', 'book-three-id', [
      { id: 'c3', voiceId: 'v_x', overrideTtsVoices: slot, matchedFrom: { bookTitle: 'Book Two', confidence: 0.9 } },
    ]);
    expect(await shouldMintApart(two2, x)).toBe(true);
  });

  it('false: the other book links back to this one (source side of a live pair)', async () => {
    reset();
    const two = book('Two', TWO_ID, [x]);
    book('One', ONE_ID, [
      { id: 'c1', voiceId: 'v_x', overrideTtsVoices: slot, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } },
    ]);
    expect(await shouldMintApart(two, x)).toBe(false);
  });
});

describe('findLinkFollowers (#3992)', () => {
  const THREE_ID = 'book-three-id';
  const FOUR_ID = 'book-four-id';
  const names = (fs: Array<{ dir: string; characterId: string }>) =>
    fs.map((f) => `${basename(f.dir)}:${f.characterId}`).sort();

  it('finds DIRECT followers only (one hop), and not a row whose uuid differs', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    book('Four', FOUR_ID, [
      { id: 'c4', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
      { id: 'c4x', voiceUuid: 'other', matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
    ]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });

  it('does not follow a link that names another book or another character', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }, { id: 'c9', voiceUuid: 'z' }]);
    book('Three', THREE_ID, [
      { id: 'c3', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c2' } },
      { id: 'c3b', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c9' } },
      { id: 'c3c', voiceUuid: U, matchedFrom: { characterId: 'c2' } },
      { id: 'c3d', voiceUuid: U },
    ]);
    expect(await findFollowers(two, { id: 'c2' }, U)).toEqual([]);
  });

  it('a link with no characterId follows the row with the SAME id, and only that one (pass 3)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: TWO_ID } },
      { id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID } },
    ]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c2']);
  });

  it('a cycle cannot loop: only the rows that name X itself are reported, once', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [
      { id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } },
      { id: 'c3b', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
    ]);
    book('Four', FOUR_ID, [
      { id: 'c4', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
      { id: 'c4b', voiceUuid: U, matchedFrom: { bookId: FOUR_ID, characterId: 'c4' } },
    ]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });

  it('a link that names a RETIRED id of the followed character still follows', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    writeFileSync(
      join(two, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { c2_old: 'c2' } }),
    );
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2_old' } }]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });

  it('scanLinkFollowers reports the folders it could not read, so a caller can tell an invisible follower (pass-2 F)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    const scan = await scanFollowers(two, { id: 'c2' }, U);
    expect(scan.followers.map((f) => f.characterId)).toEqual(['c3']);
    expect(scan.unreadableDirs.map((d) => basename(d))).toEqual(['Bad']);
    reset();
    expect((await scanFollowers(book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]), { id: 'c2' }, U)).unreadableDirs).toEqual([]);
  });

  it('an unreadable book in the way is skipped, not thrown', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });
});

describe('decideSharedVoiceDesign (#3992 fail-closed rule)', () => {
  const THREE = 'book-three-id';
  const FOUR = 'book-four-id';
  const link = (bookId: string, characterId: string | null = 'c') => ({ bookId, ...(characterId ? { characterId } : {}) });
  const declined = { declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] };

  function chain() {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, ...declined }]);
    return book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
  }

  it('an unlinked declined row that shares its uuid separates (the two-book fork)', async () => {
    chain();
    const two = join(root, 'books', 'Author', 'Series', 'Two');
    expect(await decide(two, { id: 'c', voiceUuid: U, ...declined })).toEqual({ kind: 'separate' });
  });

  it('the earlier book itself, and a never-shared voice, proceed', async () => {
    chain();
    const one = join(root, 'books', 'Author', 'Series', 'One');
    expect(await decide(one, { id: 'c', voiceUuid: U })).toEqual({ kind: 'proceed' });
    reset();
    const solo = book('Solo', 'solo-id', [{ id: 'c', voiceUuid: 'u_solo', matchedFrom: link('gone-id') }]);
    expect(await decide(solo, { id: 'c', voiceUuid: 'u_solo', matchedFrom: link('gone-id') })).toEqual({ kind: 'proceed' });
  });

  it('a direct follower of an unforked declined row is refused, naming that row’s book', async () => {
    const three = chain();
    expect(await decide(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toEqual({
      kind: 'refuse',
      message: 'Redesign "Two" first. This voice is shared with it.',
    });
  });

  it('a row two links below the declined row is refused, never walked', async () => {
    chain();
    const four = book('Four', FOUR, [{ id: 'c', voiceUuid: U, matchedFrom: link(THREE) }]);
    expect(await decide(four, { id: 'c', voiceUuid: U, matchedFrom: link(THREE) })).toEqual({
      kind: 'refuse',
      message:
        'Redesign "One" to change this shared voice, or choose "Don\'t reuse" to give this character its own.',
    });
  });

  it('a stranded row (its source left the uuid it declined) is refused', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: 'u_two', ...declined }]);
    const three = book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    expect((await decide(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).kind).toBe('refuse');
  });

  it('a decline recorded by book only (no uuid list) still counts', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: 'u_two', declinedVoiceFrom: DECLINED }]);
    const three = book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    expect((await decide(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).kind).toBe('refuse');
  });

  it('a plain series chain nobody declined proceeds, however long', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, matchedFrom: link(ONE_ID) }]);
    book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    const four = book('Four', FOUR, [{ id: 'c', voiceUuid: U, matchedFrom: link(THREE) }]);
    expect(await decide(four, { id: 'c', voiceUuid: U, matchedFrom: link(THREE) })).toEqual({ kind: 'proceed' });
  });

  it('a direct follower of a non-declining root proceeds even with a decline elsewhere on the voice', async () => {
    chain();
    const four = book('Four', FOUR, [{ id: 'c', voiceUuid: U, matchedFrom: link(ONE_ID) }]);
    expect(await decide(four, { id: 'c', voiceUuid: U, matchedFrom: link(ONE_ID) })).toEqual({ kind: 'proceed' });
  });

  it('a link cycle returns at once', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: 'u_s' }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: 'u_s', matchedFrom: link(THREE), declinedVoiceUuids: ['u_t'] }]);
    const three = book('Three', THREE, [
      { id: 'c', voiceUuid: 'u_t', matchedFrom: link(TWO_ID), declinedVoiceFrom: [TWO_ID], declinedVoiceUuids: ['u_s'] },
    ]);
    const two = join(root, 'books', 'Author', 'Series', 'Two');
    expect((await decide(two, { id: 'c', voiceUuid: 'u_s', matchedFrom: link(THREE) })).kind).toBe('refuse');
    expect((await decide(three, { id: 'c', voiceUuid: 'u_t', matchedFrom: link(TWO_ID) })).kind).toBe('proceed');
  });

  it('a link into a book whose cast.json or state.json cannot be read refuses with the retry sentence (#4025)', async () => {
    const three = chain();
    const two = join(root, 'books', 'Author', 'Series', 'Two');
    writeFileSync(join(two, '.audiobook', 'state.json'), '{"bookId":');
    const retry = { kind: 'refuse', message: 'A book in this series could not be read; try again once it can.' };
    expect(await decide(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toEqual(retry);
    chain();
    writeFileSync(join(two, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    expect(await decide(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toEqual(retry);
  });

  it('a holder linking into an unreadable book puts a decline in play: a chain below it is refused', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    const bad = book('Bad', TWO_ID, []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    const four = book('Four', FOUR, [{ id: 'c', voiceUuid: U, matchedFrom: link(THREE) }]);
    expect((await decide(four, { id: 'c', voiceUuid: U, matchedFrom: link(THREE) })).kind).toBe('refuse');
  });

  it('legacy: a row linked to a declined legacy row is refused naming it; a legacy row nobody shares a key with proceeds', async () => {
    reset();
    const slot = { qwen: { name: 'qwen-v_x' } };
    book('One', ONE_ID, [{ id: 'c', voiceId: 'v_x', overrideTtsVoices: slot }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v_x', overrideTtsVoices: slot, declinedVoiceFrom: DECLINED }]);
    const three = book('Three', THREE, [{ id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) }]);
    expect(await decide(three, { id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) })).toEqual({
      kind: 'refuse',
      message: 'Redesign "Two" first. This voice is shared with it.',
    });
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceId: 'v_x', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v_x', voiceUuid: U, ...declined }]);
    const three2 = book('Three', THREE, [{ id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) }]);
    expect(await decide(three2, { id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) })).toEqual({ kind: 'proceed' });
  });

  it('legacy: a row linked to a source that minted apart is refused while the earlier book keeps the legacy key', async () => {
    reset();
    const slot = { qwen: { name: 'qwen-v_x' } };
    book('One', ONE_ID, [{ id: 'c', voiceId: 'v_x', overrideTtsVoices: slot }]);
    book('Two', TWO_ID, [{ id: 'c', voiceId: 'v_x', voiceUuid: 'u_two', declinedVoiceFrom: DECLINED }]);
    const three = book('Three', THREE, [{ id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) }]);
    expect((await decide(three, { id: 'c', voiceId: 'v_x', matchedFrom: link(TWO_ID) })).kind).toBe('refuse');
  });
});
