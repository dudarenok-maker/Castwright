import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let shouldFork: typeof import('./voice-uuid-fork.js').shouldForkSharedVoiceUuid;

const U = 'uuid-shared';
const ONE_ID = 'book-one-id';
const TWO_ID = 'book-two-id';

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
  ({ shouldForkSharedVoiceUuid: shouldFork } = await import('./voice-uuid-fork.js'));
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
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U })).toBe(true);
  });

  it('does not fork when Book Two has a matchedFrom to Book One', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const mf = { bookId: ONE_ID, characterId: 'c1', bookTitle: 'One', confidence: 0.9 };
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, matchedFrom: mf })).toBe(false);
  });

  it('does not fork when Book Two has a bookId-less matchedFrom (manual Assign)', async () => {
    reset();
    book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    const two = book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U }]);
    const mf = { bookTitle: 'One', confidence: 1 };
    expect(await shouldFork(two, { id: 'c2', voiceUuid: U, matchedFrom: mf })).toBe(false);
  });

  it('source side: Book One does not fork while Book Two links to it', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c1' } },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U })).toBe(false);
  });

  it('source side: a bookId-less link from Book Two also protects Book One', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c2', voiceUuid: U, matchedFrom: { bookTitle: 'One' } }]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U })).toBe(false);
  });

  it('forks when Book Two links to a different character id of Book One', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }, { id: 'c9' }]);
    book('Two', TWO_ID, [
      { id: 'c2', voiceUuid: U, matchedFrom: { bookId: ONE_ID, characterId: 'c9' } },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U })).toBe(true);
  });

  it('does not fork for a sole holder or a character without a uuid', async () => {
    reset();
    const one = book('One', ONE_ID, [{ id: 'c1', voiceUuid: U }]);
    book('Two', TWO_ID, [{ id: 'c2', voiceUuid: 'other' }]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U })).toBe(false);
    expect(await shouldFork(one, { id: 'c1' })).toBe(false);
  });

  it('a same-book sibling with the same uuid is not a holder', async () => {
    reset();
    const one = book('One', ONE_ID, [
      { id: 'c1', voiceUuid: U },
      { id: 'c1b', voiceUuid: U },
    ]);
    expect(await shouldFork(one, { id: 'c1', voiceUuid: U })).toBe(false);
  });
});
