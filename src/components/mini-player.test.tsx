/* MiniPlayer chapter switch — regression for the "preview stalls when you
   click a different chapter" bug.

   Before the fix, Effect 1 fired off a fetch for the new chapter but left
   `audio` state holding the previous chapter's URL. Because Effect 2 only
   re-runs when audio.url changes, the <audio> element kept playing chapter
   A's MP3 while the UI showed chapter B, until B's metadata fetch resolved.
   On a slow/erroring backend that window could feel like a stalled click.

   The fix resets audio={url:null,...} synchronously inside Effect 1 so
   Effect 2 immediately strips the element's src and stops playback. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { MiniPlayer } from './mini-player';
import type { Chapter, ChapterAudio } from '../lib/types';

type Resolver = (meta: ChapterAudio) => void;
const pendingByChapter = new Map<number, Resolver>();
const getChapterAudioMock = vi.fn();
/* Plan 47 — listen-progress mocks. Default: getListenProgress
   returns null (no prior session); putListenProgress is a resolved
   promise that the per-test cases assert was/wasn't called. */
const getListenProgressMock = vi.fn(async (_bookId: string) => null);
const putListenProgressMock = vi.fn(
  async (_bookId: string, args: { chapterId: number; currentSec: number }) => ({
    chapterId: args.chapterId,
    currentSec: args.currentSec,
    updatedAt: new Date().toISOString(),
  }),
);

vi.mock('../lib/api', () => ({
  api: {
    getChapterAudio: ({ chapterId }: { chapterId: number }) => {
      getChapterAudioMock(chapterId);
      return new Promise<ChapterAudio>((resolve) => {
        pendingByChapter.set(chapterId, resolve);
      });
    },
    /* Plan 47 — listen-progress hooks. Defaults to "no resume point"
       so the existing test cases see the legacy seek-to-0 behaviour.
       Per-test overrides via getListenProgressMock.mockImplementation
       drive the resume-seek + save-flush specs below. */
    getListenProgress: (bookId: string) => getListenProgressMock(bookId),
    putListenProgress: (
      bookId: string,
      args: { chapterId: number; currentSec: number },
    ) => putListenProgressMock(bookId, args),
  },
}));

beforeEach(() => {
  pendingByChapter.clear();
  getChapterAudioMock.mockReset();
  getListenProgressMock.mockReset();
  /* Default — no resume point. Per-test cases override via
     mockResolvedValueOnce / mockImplementationOnce. */
  getListenProgressMock.mockResolvedValue(null);
  putListenProgressMock.mockReset();
  putListenProgressMock.mockImplementation(async (_bookId, args) => ({
    chapterId: args.chapterId,
    currentSec: args.currentSec,
    updatedAt: new Date().toISOString(),
  }));
  /* jsdom only stubs HTMLMediaElement minimally — load is a no-op and play
     returns undefined synchronously. Replace play with a resolved-promise
     stub so the component's `void el.play().catch(...)` doesn't trip
     unhandled-rejection noise from any teardown ordering. */
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  pendingByChapter.clear();
});

const chapter1: Chapter = {
  id: 1,
  title: 'Chapter One',
  duration: '11:32',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done' },
};
const chapter2: Chapter = {
  id: 2,
  title: 'Chapter Two',
  duration: '08:14',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done' },
};

const noop = () => {};

async function resolveChapter(id: number, url: string) {
  const resolver = pendingByChapter.get(id);
  if (!resolver) throw new Error(`No pending fetch for chapter ${id}`);
  /* The .then handler in MiniPlayer's Effect 1 fires setAudio when this
     resolves; wrap in act so React's commit + Effect 2 run inside the
     test's act window instead of leaking past it. */
  await act(async () => {
    resolver({ url, durationSec: 600, peaks: [], sampleRate: 44100, segments: [] });
  });
}

describe('MiniPlayer — chapter switch', () => {
  it('clears the audio element src when the chapter prop changes, then loads the new URL once metadata arrives', async () => {
    const { container, rerender } = render(
      <MiniPlayer
        chapter={chapter1}
        bookId="book-1"
        onClose={noop}
        onPrev={noop}
        onNext={noop}
        prevAvailable={false}
        nextAvailable={true}
      />,
    );

    const audioEl = container.querySelector('audio');
    expect(audioEl).not.toBeNull();

    /* Chapter 1's metadata lands → element points at chapter 1's MP3. */
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await waitFor(() => expect(audioEl!.getAttribute('src')).toMatch(/\/chapters\/1\/audio\.mp3$/));

    /* User clicks Preview on chapter 2 BEFORE the fetch resolves. The
       regression: src used to stay pinned to chapter 1 here, so chapter 1
       kept playing under the chapter 2 UI. */
    rerender(
      <MiniPlayer
        chapter={chapter2}
        bookId="book-1"
        onClose={noop}
        onPrev={noop}
        onNext={noop}
        prevAvailable={true}
        nextAvailable={false}
      />,
    );

    await waitFor(() => expect(audioEl!.getAttribute('src')).toBeNull());
    expect(getChapterAudioMock).toHaveBeenLastCalledWith(2);

    /* Chapter 2's metadata lands → element now points at chapter 2's MP3. */
    await resolveChapter(2, '/api/books/book-1/chapters/2/audio.mp3');
    await waitFor(() => expect(audioEl!.getAttribute('src')).toMatch(/\/chapters\/2\/audio\.mp3$/));
  });
});
