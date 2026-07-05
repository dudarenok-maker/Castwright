import { describe, it, expect, vi } from 'vitest';

describe('DEMO_CAPTURE-gated api.ts mocks (#1286 Quality Gate marketing screenshots)', () => {
  it('mockGetChapterAudio: hollow-tide-2 chapter 3 gets the acoustic+ASR segment override, same timings', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const audio = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 3 });
    const suspects = audio.segments.filter((s) => s.suspect);

    expect(suspects).toHaveLength(2);
    expect(suspects.map((s) => s.characterId)).toEqual(['dockhand-remy', 'narrator']);
    expect(suspects[0].reasons).toEqual([
      'Content drift — heard "the ropes" where the script says "the ledger."',
    ]);
    expect(suspects[1].reasons).toEqual(['Near-silent — dead air detected before this line.']);
    // Timings unchanged from the generic layout (totalSec=600 default duration):
    // third=200, third*2=400, lateStart=488.
    expect(suspects[0].start).toBe(200);
    expect(suspects[0].end).toBe(400);
    expect(suspects[1].start).toBe(488);
    expect(suspects[1].end).toBe(600);
  });

  it('mockGetChapterAudio: every other chapter/book keeps the generic halloran/narrator segments', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    const otherChapter = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 4 });
    expect(
      otherChapter.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);

    const otherBook = await api.getChapterAudio({ bookId: 'coalfall-commission', chapterId: 3 });
    expect(
      otherBook.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);
  });

  it('mockGetChapterAudio: the override never fires outside DEMO_CAPTURE', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '0');
    const { api } = await import('./api');

    const audio = await api.getChapterAudio({ bookId: 'hollow-tide-2', chapterId: 3 });
    expect(
      audio.segments.filter((s) => s.suspect).map((s) => s.characterId),
    ).toEqual(['halloran', 'narrator']);
  });

  it('mockGetChapterAudio: the override ignores a passed duration:"00:00" (the mini-player Preview bug)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    vi.stubEnv('VITE_DEMO_CAPTURE', '1');
    const { api } = await import('./api');

    // Mirrors mini-player.tsx:228's call shape for a chapter whose hydrated
    // duration defaulted to '00:00' (Saltgrave's chapters carry no duration
    // field). Without the totalSec-forcing fix this would collapse
    // durationSec to 0 and deriveIssues would find no issues at all.
    const audio = await api.getChapterAudio({
      bookId: 'hollow-tide-2',
      chapterId: 3,
      duration: '00:00',
    });
    expect(audio.durationSec).toBe(600);
    expect(audio.segments.filter((s) => s.suspect)).toHaveLength(2);
  });
});
