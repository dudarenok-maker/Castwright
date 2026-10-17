import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from './api';
import { RevisionOpFailure } from './revision-op-failure';

const STATE = { bookId: 'b', fileId: '000000000000001-a', rev: 2, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };
let fetchMock: ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('plan 286 — revision op routes (real)', () => {
  it('accept POSTs the selection to the per-op route and returns the state', async () => {
    fetchMock.mockResolvedValueOnce(json(200, STATE));
    const out = await api.acceptRevision({ bookId: 'b k', revisionId: 'revision:3:1', selection: { 0: 'A' } });
    expect(out).toEqual(STATE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/books/b%20k/revisions/revision%3A3%3A1/accept');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ selection: { 0: 'A' } });
  });
  it('accept with no selection sends {}', async () => {
    fetchMock.mockResolvedValueOnce(json(200, STATE));
    await api.acceptRevision({ bookId: 'b', revisionId: 'r' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });
  it('a coded 409 throws RevisionOpFailure carrying code, message and state', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'revision_gone', message: 'gone', state: STATE }));
    const err = await api.rejectRevision({ bookId: 'b', revisionId: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(RevisionOpFailure);
    expect(err).toMatchObject({ status: 409, code: 'revision_gone', message: 'gone', state: STATE });
  });
  it('an uncoded 500 is "unexpected" and keeps the server sentence', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'Failed to dismiss drift.' }));
    const err = await api.dismissDrift({ bookId: 'b', driftId: 'd' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'unexpected', message: 'Failed to dismiss drift.' });
  });
  it('dismiss POSTs to the drift route of the given book', async () => {
    fetchMock.mockResolvedValueOnce(json(200, STATE));
    await api.dismissDrift({ bookId: 'b', driftId: 'drift:b:1:eliza:voice' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/books/b/drift/drift%3Ab%3A1%3Aeliza%3Avoice/dismiss');
  });
  it('restore-unrecorded: 204 → restored, 404 → none, 409 → throws has_revision', async () => {
    fetchMock.mockResolvedValueOnce(json(204, null)).mockResolvedValueOnce(json(404, { error: 'no_previous_audio' }))
      .mockResolvedValueOnce(json(409, { error: 'has_revision', message: 'older' }));
    expect(await api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).toBe('restored');
    expect(await api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).toBe('none');
    await expect(api.restorePreviousUnrecorded({ bookId: 'b', chapterId: 3 })).rejects.toMatchObject({ code: 'has_revision' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/books/b/chapters/3/audio/previous/restore-unrecorded');
  });
});
