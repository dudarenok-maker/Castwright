import { describe, it, expect } from 'vitest';
import { chapterHoldsAudio } from './chapter-holds-audio';
import type { ChaptersState } from './chapters-slice';

/* #3435 (PR #3505 review pass 8) — a re-run keeps the text of a chapter with
   audio. Each audio signal is tested ALONE, so removing any one clause fails
   its own test; a chapter with no audio evidence (queued, or failed before
   it ever rendered) holds none. */
function slice(
  chapter: Record<string, unknown> | null,
  maps: { text?: Record<number, Record<number, string>>; speakers?: Record<number, Record<number, string>> } = {},
): Pick<ChaptersState, 'chapters' | 'renderedTextByChapter' | 'renderedSpeakersByChapter'> {
  return {
    chapters: chapter ? ([{ id: 1, state: 'queued', ...chapter }] as never) : [],
    renderedTextByChapter: maps.text ?? {},
    renderedSpeakersByChapter: maps.speakers ?? {},
  };
}

describe('chapterHoldsAudio', () => {
  it('done alone holds audio', () => {
    expect(chapterHoldsAudio(slice({ state: 'done' }), 1)).toBe(true);
  });
  it('in_progress alone holds audio', () => {
    expect(chapterHoldsAudio(slice({ state: 'in_progress' }), 1)).toBe(true);
  });
  it('audioRenderedAt alone holds audio', () => {
    expect(chapterHoldsAudio(slice({ audioRenderedAt: '2026-10-01T00:00:00Z' }), 1)).toBe(true);
  });
  it('a rendered-text map entry alone holds audio', () => {
    expect(chapterHoldsAudio(slice({}, { text: { 1: { 1: 'h' } } }), 1)).toBe(true);
  });
  it('a rendered-speakers map entry alone holds audio', () => {
    expect(chapterHoldsAudio(slice({}, { speakers: { 1: { 1: 'narrator' } } }), 1)).toBe(true);
  });
  it('a map entry holds audio even when the chapter row is gone', () => {
    expect(chapterHoldsAudio(slice(null, { text: { 1: { 1: 'h' } } }), 1)).toBe(true);
  });
  it('queued holds none', () => {
    expect(chapterHoldsAudio(slice({ state: 'queued' }), 1)).toBe(false);
  });
  it('failed with no audio holds none', () => {
    expect(chapterHoldsAudio(slice({ state: 'failed' }), 1)).toBe(false);
  });
  it("another chapter's evidence is not this chapter's", () => {
    expect(chapterHoldsAudio(slice({}, { text: { 2: { 1: 'h' } } }), 1)).toBe(false);
  });
});
