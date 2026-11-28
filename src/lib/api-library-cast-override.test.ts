/* #4564 (PR #4862 review pass 1) — POST /api/library-cast/override answers 409 `book_busy` while an
   analysis holds either book. The thrown error must carry the code so Confirm can tell that refusal
   from a failure and say so, instead of the sync vanishing into the console. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const args = {
  sourceBookId: 'b2',
  sourceCharacterId: 'c2',
  targetBookId: 'b1',
  targetCharacterId: 'c1',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('overrideLibraryCast error codes', () => {
  it('a 409 book_busy rejects with code book_busy and the server sentence', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      json(409, { error: 'This book is busy (analysing).', code: 'book_busy' }),
    );
    await expect(api.overrideLibraryCast(args)).rejects.toMatchObject({
      code: 'book_busy',
      message: 'This book is busy (analysing).',
    });
  });

  it('a failure without a code rejects with no code', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(json(404, { error: 'Target character "c1" not found.' }));
    const err = await api.overrideLibraryCast(args).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBeUndefined();
    expect((err as Error).message).toBe('Target character "c1" not found.');
  });
});
