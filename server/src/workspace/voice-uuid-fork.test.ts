import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

let root: string;
let shouldFork: typeof import('./voice-uuid-fork.js').shouldForkSharedVoiceUuid;
let shouldMintApart: typeof import('./voice-uuid-fork.js').shouldMintApartFromLegacyKey;
let findFollowers: typeof import('./voice-uuid-fork.js').findLinkFollowers;
let findAncestor: typeof import('./voice-uuid-fork.js').findDeclinedAncestor;
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
    findDeclinedAncestor: findAncestor,
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
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U, matchedFrom: { bookTitle: 'One' } }]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(true);
  });

  it('forks when Book Two links to a different character id of Book One', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }, { id: 'c9' }]);
    book('Two', TWO_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c9' } },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(true);
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

  it('an unreadable cast.json in another book is a possible holder: it forks, and does not throw (pass-2 U)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    const still = { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] };
    expect(await shouldFork(two, still)).toBe(true);
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    expect(await shouldFork(two, still)).toBe(true);
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

  it('finds a chain end to end, and not a row whose uuid differs', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    book('Four', FOUR_ID, [
      { id: 'c4', voiceUuid: U, matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
      { id: 'c4x', voiceUuid: 'other', matchedFrom: { bookId: THREE_ID, characterId: 'c3' } },
    ]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Four:c4', 'Three:c3']);
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

  it('a cycle terminates and reports each row once', async () => {
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
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Four:c4', 'Four:c4b', 'Three:c3', 'Three:c3b']);
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

describe('findDeclinedAncestor (#3992 pass-2 finding 3)', () => {
  const THREE = 'book-three-id';
  const FOUR = 'book-four-id';
  const link = (bookId: string, characterId: string | null = 'c') => ({ bookId, ...(characterId ? { characterId } : {}) });

  function chain() {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, declinedVoiceFrom: DECLINED }]);
    return book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
  }

  it('returns the declined row a linked row follows', async () => {
    const three = chain();
    const found = await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) });
    expect(found && 'dir' in found && [basename(found.dir), found.characterId]).toEqual(['Two', 'c']);
  });

  it('walks several links up', async () => {
    chain();
    const four = book('Four', FOUR, [{ id: 'c', voiceUuid: U, matchedFrom: link(THREE) }]);
    const found = await findAncestor(four, { id: 'c', voiceUuid: U, matchedFrom: link(THREE) });
    expect(found && 'dir' in found && basename(found.dir)).toBe('Two');
  });

  it('returns the source’s uuid for a follower stranded on a voice the source forked away from (pass 3)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    book('Two', TWO_ID, [
      { id: 'c', voiceUuid: 'u_two', declinedVoiceFrom: DECLINED, declinedVoiceUuids: [U] },
    ]);
    const three = book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    expect(await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toEqual({
      voiceUuid: 'u_two',
    });
  });

  it('a source on another uuid that never declined this one is not a stranding', async () => {
    reset();
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: 'u_two' }]);
    const three = book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    expect(await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toBeNull();
  });

  it('null when nothing up the chain declined: a plain link shares by design', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, matchedFrom: link(ONE_ID) }]);
    expect(await findAncestor(two, { id: 'c', voiceUuid: U, matchedFrom: link(ONE_ID) })).toBeNull();
  });

  it('null when the linked row no longer holds the uuid, or names no character; a legacy walker takes the source uuid', async () => {
    const three = chain();
    expect(await findAncestor(three, { id: 'c', voiceUuid: 'other', matchedFrom: link(TWO_ID) })).toBeNull();
    // a legacy walker (no uuid) whose source holds one takes it (#3992 pass 4): the series mint would restamp the source
    expect(await findAncestor(three, { id: 'c', matchedFrom: link(TWO_ID) })).toEqual({ voiceUuid: U });
    // ...but a source with no uuid either has nothing to follow
    expect(await findAncestor(three, { id: 'c', voiceId: 'v_none', matchedFrom: link(TWO_ID, 'nobody') })).toBeNull();
    expect(await findAncestor(three, { id: 'zzz', voiceUuid: U, matchedFrom: link(TWO_ID, null) })).toBeNull();
    // no characterId: the same id in the linked book is the source (the follower rule's reading)
    const found = await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID, null) });
    expect(found && 'dir' in found && found.characterId).toBe('c');
    expect(await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: { characterId: 'c' } })).toBeNull();
  });

  it('terminates on a link cycle', async () => {
    reset();
    book('Two', TWO_ID, [{ id: 'c', voiceUuid: U, matchedFrom: link(THREE) }]);
    const three = book('Three', THREE, [{ id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) }]);
    expect(await findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).toBeNull();
  });

  it('throws when the book it links to cannot be read (it may be the target), instead of walking on', async () => {
    const three = chain();
    writeFileSync(join(root, 'books', 'Author', 'Series', 'Two', '.audiobook', 'cast.json'), '{"characters":[{"id":');
    await expect(findAncestor(three, { id: 'c', voiceUuid: U, matchedFrom: link(TWO_ID) })).rejects.toThrow(
      /could not be read/,
    );
  });
});
