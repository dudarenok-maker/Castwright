/* #3713 / PR #4004 pass 3 -- the three cast writers that name the book in the request BODY
   (or query), not the path, still carry the repaired-id read token for the book(s) they
   write. Runs against the real `api` (VITE_USE_MOCKS unset in vitest). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import {
  __resetBookReadTokensForTest,
  bookFetch,
  commitBookReadToken,
  setRepairedBookHandler,
} from './book-read-token';

const fetchMock = vi.fn();
const tokenOf = (call: number) =>
  new Headers((fetchMock.mock.calls[call][1] as RequestInit | undefined)?.headers).get('x-book-read-token');
const ok = () => new Response(JSON.stringify({ updated: 1, cleared: [], written: [] }), { status: 200 });

async function readAndCommit(bookId: string, token: string) {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'x-book-read-token': token } }));
  await bookFetch(`/api/books/${bookId}/state`);
  commitBookReadToken(bookId);
}

beforeEach(() => {
  __resetBookReadTokensForTest();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('body-keyed cast writers carry the repaired-id token', () => {
  it('assignLibraryVoice echoes the token of the book in its body', async () => {
    await readAndCommit('b1', 'tok1');
    fetchMock.mockResolvedValue(ok());
    await api.assignLibraryVoice('lib-1', { bookId: 'b1', characterId: 'c1' });
    expect(tokenOf(1)).toBe('tok1');
  });

  it('unassignLibraryVoice echoes the token of the book in its query', async () => {
    await readAndCommit('b1', 'tok1');
    fetchMock.mockResolvedValue(ok());
    await api.unassignLibraryVoice('lib-1', { bookId: 'b1', characterId: 'c1' });
    expect(tokenOf(1)).toBe('tok1');
  });

  it('overrideLibraryCast echoes both books\' tokens, comma-joined', async () => {
    await readAndCommit('src', 'tokS');
    await readAndCommit('tgt', 'tokT');
    fetchMock.mockResolvedValue(ok());
    await api.overrideLibraryCast({
      sourceBookId: 'src', sourceCharacterId: 'c0', targetBookId: 'tgt', targetCharacterId: 'c0',
    });
    expect(tokenOf(2)!.split(',').sort()).toEqual(['tokS', 'tokT']);
  });

  it('linkPriorCharacter echoes the path book\'s and the target book\'s tokens (pass 4)', async () => {
    await readAndCommit('src', 'tokS');
    await readAndCommit('tgt', 'tokT');
    fetchMock.mockResolvedValue(ok());
    await api.linkPriorCharacter({ bookId: 'src', sourceCharacterId: 'c0', targetBookId: 'tgt', targetCharacterId: 'c1' });
    expect(tokenOf(2)!.split(',').sort()).toEqual(['tokS', 'tokT']);
  });

  it('addFromSeriesRoster echoes the path book\'s and the target book\'s tokens (pass 4)', async () => {
    await readAndCommit('src', 'tokS');
    await readAndCommit('tgt', 'tokT');
    fetchMock.mockResolvedValue(ok());
    await api.addFromSeriesRoster({ bookId: 'src', targetBookId: 'tgt', targetCharacterId: 'c1' });
    expect(tokenOf(2)!.split(',').sort()).toEqual(['tokS', 'tokT']);
  });

  it('a series-scope setVoiceOverride echoes the token of the book it names (pass 4)', async () => {
    await readAndCommit('b1', 'tok1');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.setVoiceOverride('v1', { engine: 'kokoro', name: 'af_heart' }, { scope: 'series', bookId: 'b1' });
    expect(tokenOf(1)).toBe('tok1');
  });

  it('markNotLinkedTo and its undo echo the path book\'s and the other book\'s tokens (pass 4)', async () => {
    await readAndCommit('src', 'tokS');
    await readAndCommit('tgt', 'tokT');
    fetchMock.mockImplementation(async () => ok());
    const args = { bookId: 'src', characterId: 'c0', otherBookId: 'tgt', otherCharacterId: 'c1' };
    await api.notLinkedTo(args);
    await api.removeNotLinkedTo(args);
    expect(tokenOf(2)!.split(',').sort()).toEqual(['tokS', 'tokT']);
    expect(tokenOf(3)!.split(',').sort()).toEqual(['tokS', 'tokT']);
  });

  it('sends no header for a book with no committed token (nothing repaired)', async () => {
    fetchMock.mockResolvedValue(ok());
    await api.assignLibraryVoice('lib-1', { bookId: 'b9', characterId: 'c1' });
    expect(tokenOf(0)).toBeNull();
  });

  it('a book_repaired_reload refusal on assign tells the handler which book to re-read', async () => {
    const handler = vi.fn();
    setRepairedBookHandler(handler);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'repaired', code: 'book_repaired_reload' }), { status: 409 }),
    );
    await expect(api.assignLibraryVoice('lib-1', { bookId: 'b1', characterId: 'c1' })).rejects.toThrow();
    expect(handler).toHaveBeenCalledWith('b1');
  });
});
