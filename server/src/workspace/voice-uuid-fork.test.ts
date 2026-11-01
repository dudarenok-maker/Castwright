import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

let root: string;
let shouldFork: typeof import('./voice-uuid-fork.js').shouldForkSharedVoiceUuid;
let shouldMintApart: typeof import('./voice-uuid-fork.js').shouldMintApartFromLegacyKey;
let findFollowers: typeof import('./voice-uuid-fork.js').findLinkFollowers;

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

  it('an unreadable cast.json in another book is skipped, not thrown (and holds nothing)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(false);
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, declinedVoiceFrom: DECLINED })).toBe(true);
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

  it('a link with no characterId follows (any row of the named book)', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID } }]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });

  it('a cycle terminates and reports each row once', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    book('Three', THREE_ID, [
      { id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } },
      { id: 'c3b', voiceUuid: U, matchedFrom: { bookId: THREE_ID } },
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

  it('an unreadable book in the way is skipped, not thrown', async () => {
    reset();
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const bad = book('Bad', 'bad-id', []);
    writeFileSync(join(bad, '.audiobook', 'cast.json'), '{"characters":[{"id":');
    book('Three', THREE_ID, [{ id: 'c3', voiceUuid: U, matchedFrom: { bookId: TWO_ID, characterId: 'c2' } }]);
    expect(names(await findFollowers(two, { id: 'c2' }, U))).toEqual(['Three:c3']);
  });
});
