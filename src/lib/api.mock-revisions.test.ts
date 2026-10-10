import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetMockBookStates,
  _mockPollRevisions,
  _mockGetChapterAudioPrevious,
  _mockStreamSplice,
  _mockStreamGeneration,
  _mockStreamQaRepair,
  mockGetBookState,
} from './api';
import { seedMockRevisions, getMockRevisions, mockDismissDrift } from '../mocks/mock-revisions';

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

describe('mock renders record pending (plan 286)', () => {
  afterEach(() => vi.useRealTimers());

  it('a splice records a server entry for the chapter and reports reviewOutcome recorded', async () => {
    const ticks: Array<{ type: string; reviewOutcome?: string }> = [];
    await _mockStreamSplice({ bookId: 'cc', chapterId: 2, mode: 'remix', characterId: 'eliza_cc', gainDb: 3, onTick: (t: typeof ticks[number]) => ticks.push(t) } as never);
    expect(ticks.at(-1)).toMatchObject({ type: 'splice_complete', reviewOutcome: 'recorded' });
    const p = getMockRevisions('cc').pending;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ chapterId: 2, origin: 'server', triggeredBy: expect.stringMatching(/^Loudness fix \(/) });
  });

  const genArgs = (withReview: boolean, onTick: (t: Record<string, unknown>) => void) => ({
    bookId: 'cc', modelKey: 'kokoro-v1', chapterIds: [1], force: true, mockGenConcurrency: 1,
    ...(withReview ? { review: { characterId: 'eliza_cc', triggeredBy: 'Eliza voice change' } } : {}),
    getChapters: () => [{ id: 1, title: 'One', duration: '01:00', state: 'in_progress', progress: 0.99, totalLines: 10, characters: {} }],
    onTick,
  });

  it('a review render of a chapter with audio records an entry and stamps reviewChapter on chapter_complete', async () => {
    vi.useFakeTimers();
    seedMockRevisions('cc', { liveChapterIds: [1] });
    const ticks: Array<Record<string, unknown>> = [];
    const stop = _mockStreamGeneration(genArgs(true, (t) => ticks.push(t)) as never);
    await vi.advanceTimersByTimeAsync(1300);
    stop();
    expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ chapterId: 1, reviewChapter: true, reviewOutcome: 'recorded' });
    expect(getMockRevisions('cc').pending).toHaveLength(1);
  });

  it('a first render (no audio yet) records nothing but still stamps reviewChapter', async () => {
    vi.useFakeTimers();
    const ticks: Array<Record<string, unknown>> = [];
    const stop = _mockStreamGeneration(genArgs(true, (t) => ticks.push(t)) as never);
    await vi.advanceTimersByTimeAsync(1300);
    stop();
    expect(ticks.find((t) => t.type === 'chapter_complete')).toMatchObject({ reviewChapter: true, reviewOutcome: 'none' });
    expect(getMockRevisions('cc').pending).toEqual([]);
  });

  it('a render without review never stamps reviewChapter, reports reviewOutcome none and drops the chapter entry', async () => {
    vi.useFakeTimers();
    seedMockRevisions('cc', { state: { pending: [{ id: 'old', chapterId: 1, characterId: 'eliza_cc', segments: [], origin: 'server' }] }, liveChapterIds: [1] });
    const ticks: Array<Record<string, unknown>> = [];
    const stop = _mockStreamGeneration(genArgs(false, (t) => ticks.push(t)) as never);
    await vi.advanceTimersByTimeAsync(1300);
    stop();
    const done = ticks.find((t) => t.type === 'chapter_complete');
    expect(done).not.toHaveProperty('reviewChapter');
    expect(done).toMatchObject({ reviewOutcome: 'none' }); // the server's answer for review:null (Task 27)
    expect(getMockRevisions('cc').pending).toEqual([]);
  });

  it('a QA repair drops the chapter entry and reports reviewOutcome none, as the server does with review:null', async () => {
    seedMockRevisions('cc', { state: { pending: [{ id: 'old', chapterId: 2, characterId: 'eliza_cc', segments: [], origin: 'server' }] }, liveChapterIds: [2] });
    const ticks: Array<{ type: string; reviewOutcome?: string }> = [];
    await _mockStreamQaRepair({ bookId: 'cc', chapterId: 2, onTick: (t: typeof ticks[number]) => ticks.push(t) } as never);
    expect(ticks.at(-1)).toMatchObject({ type: 'qa_repair_complete', reviewOutcome: 'none' });
    expect(getMockRevisions('cc').pending).toEqual([]);
  });
});
