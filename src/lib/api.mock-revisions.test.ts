import { describe, it, expect, beforeEach } from 'vitest';
import { _resetMockBookStates, _mockPollRevisions, _mockGetChapterAudioPrevious, mockGetBookState } from './api';
import { seedMockRevisions, mockDismissDrift } from '../mocks/mock-revisions';

beforeEach(() => _resetMockBookStates());

describe('mock API reads per-book revisions (plan 286, D7)', () => {
  it('the poll returns each book its own pending, never the sb fixture for every book', async () => {
    expect((await _mockPollRevisions({ bookId: 'sb' })).pending?.map((p) => p.id)).toEqual(['rev1']);
    expect((await _mockPollRevisions({ bookId: 'cc' })).pending).toEqual([]);
  });
  it('the poll carries bookId, fileId and rev', async () => {
    expect(await _mockPollRevisions({ bookId: 'sb' })).toMatchObject({ bookId: 'sb', fileId: null, rev: 0 });
  });
  it('the poll omits dismissed drift events', async () => {
    const before = (await _mockPollRevisions({ bookId: 'sb' })).drift ?? [];
    expect(before.length).toBeGreaterThan(0);
    mockDismissDrift('sb', before[0].id);
    const after = (await _mockPollRevisions({ bookId: 'sb' })).drift ?? [];
    expect(after.map((d) => d.id)).not.toContain(before[0].id);
    expect(after).toHaveLength(before.length - 1);
  });
  it('getBookState overlays the mock revisions state for a seeded book only', async () => {
    seedMockRevisions('cc', { state: { pending: [{ id: 'x', chapterId: 1, characterId: 'eliza', segments: [], origin: 'server' }] } });
    expect((await mockGetBookState('cc'))?.revisions?.pending?.map((p) => p.id)).toEqual(['x']);
    expect((await mockGetBookState('ns'))?.revisions ?? null).toBeNull();
  });
  it('previous audio is null unless the chapter is in previousChapterIds', async () => {
    expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 3, duration: '11:31' })).not.toBeNull();
    expect(await _mockGetChapterAudioPrevious({ bookId: 'sb', chapterId: 4, duration: '11:31' })).toBeNull();
  });
});
