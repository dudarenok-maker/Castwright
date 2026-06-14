/* MiniPlayer chapter switch — regression for the "preview stalls when you
   click a different chapter" bug.

   Before the fix, Effect 1 fired off a fetch for the new chapter but left
   `audio` state holding the previous chapter's URL. Because Effect 2 only
   re-runs when audio.url changes, the <audio> element kept playing chapter
   A's MP3 while the UI showed chapter B, until B's metadata fetch resolved.
   On a slow/erroring backend that window could feel like a stalled click.

   The fix resets audio={url:null,...} synchronously inside Effect 1 so
   Effect 2 immediately strips the element's src and stops playback. */

import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MiniPlayer } from './mini-player';
import type { Chapter, ChapterAudio } from '../lib/types';
import { listenProgressSlice } from '../store/listen-progress-slice';
import { settingsSlice } from '../store/settings-slice';

/* Plan 53 — every MiniPlayer render now needs a Redux store
   because the component reads/writes the listen-progress slice for
   per-book playbackRate + markers. A fresh store per render keeps
   the existing chapter-switch + plan-47 specs hermetic.
   fe-23/fe-24 — the settings slice carries auto-advance + the skip
   deltas; including it lets the continuity specs flip those without
   relying on the optional-chained defaults. */
function makeStore() {
  return configureStore({
    reducer: {
      listenProgress: listenProgressSlice.reducer,
      settings: settingsSlice.reducer,
    },
  });
}

function renderPlayer(ui: React.ReactElement) {
  return render(<Provider store={makeStore()}>{ui}</Provider>);
}

type Resolver = (meta: ChapterAudio) => void;
const pendingByChapter = new Map<number, Resolver>();
const getChapterAudioMock = vi.fn();
/* Plan 47 — listen-progress mocks. Default: getListenProgress
   returns null (no prior session); putListenProgress is a resolved
   promise that the per-test cases assert was/wasn't called. The
   explicit return type widens to `record | null` so per-test
   mockResolvedValueOnce({ chapterId, ... }) doesn't trip on the
   default's narrowed-to-null inference. */
interface ListenProgressRecord {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
}
const getListenProgressMock = vi.fn<(bookId: string) => Promise<ListenProgressRecord | null>>(
  async () => null,
);
const putListenProgressMock = vi.fn(
  async (_bookId: string, args: { chapterId: number; currentSec: number }) => ({
    chapterId: args.chapterId,
    currentSec: args.currentSec,
    updatedAt: new Date().toISOString(),
  }),
);

const putListenStatsMock = vi.fn(async (_bookId: string, _body: unknown) => ({}));

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
    putListenProgress: (bookId: string, args: { chapterId: number; currentSec: number }) =>
      putListenProgressMock(bookId, args),
    /* fs-16 — listen-stats stub. Delegates to a module-level vi.fn() so
       per-test cases can inspect calls. Default: resolves to {}. */
    putListenStats: (bookId: string, body: unknown) => putListenStatsMock(bookId, body),
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
  putListenStatsMock.mockReset();
  putListenStatsMock.mockResolvedValue({});
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
    /* Use a single shared store across the rerender so the slice
       state survives the prop swap (matches production where the
       MiniPlayer sits inside one Provider across the whole session). */
    const store = makeStore();
    const { container, rerender } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
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
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter2}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={true}
          nextAvailable={false}
        />
      </Provider>,
    );

    await waitFor(() => expect(audioEl!.getAttribute('src')).toBeNull());
    expect(getChapterAudioMock).toHaveBeenLastCalledWith(2);

    /* Chapter 2's metadata lands → element now points at chapter 2's MP3. */
    await resolveChapter(2, '/api/books/book-1/chapters/2/audio.mp3');
    await waitFor(() => expect(audioEl!.getAttribute('src')).toMatch(/\/chapters\/2\/audio\.mp3$/));
  });
});

describe('MiniPlayer — plan 47 resume + flush', () => {
  /* Fire onLoadedMetadata against the <audio> element with a given
     duration. We can't trigger the real DOM event because jsdom never
     fetches the URL — synthesise a load event with a stubbed currentTime
     setter so the component's handler can see the duration value. */
  async function fireLoadedMetadata(audioEl: HTMLAudioElement, durationSec: number) {
    /* duration is read-only on the prototype but a per-element setter
       lets us seed the value the component reads inside onLoadedMetadata. */
    Object.defineProperty(audioEl, 'duration', { configurable: true, value: durationSec });
    await act(async () => {
      audioEl.dispatchEvent(new Event('loadedmetadata'));
    });
  }

  /* Fire onTimeUpdate against the <audio> element. The component reads
     currentTime off the event target — we set the value first, then
     dispatch the event. */
  async function fireTimeUpdate(audioEl: HTMLAudioElement, currentTimeSec: number) {
    Object.defineProperty(audioEl, 'currentTime', {
      configurable: true,
      writable: true,
      value: currentTimeSec,
    });
    await act(async () => {
      audioEl.dispatchEvent(new Event('timeupdate'));
    });
  }

  it('seeks the audio element to the resume point on onLoadedMetadata when listen-progress matches the chapter', async () => {
    getListenProgressMock.mockResolvedValueOnce({
      chapterId: 1,
      currentSec: 42,
      updatedAt: '2026-05-18T01:00:00.000Z',
    });
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    expect(audioEl).not.toBeNull();
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    /* Wait for the listen-progress GET to resolve before metadata fires;
       otherwise the seek-into-pendingSeekRef race-loses. */
    await waitFor(() => expect(getListenProgressMock).toHaveBeenCalled());
    await fireLoadedMetadata(audioEl, 600);
    expect(audioEl.currentTime).toBeCloseTo(42, 5);
  });

  it('does NOT seek when listen-progress is for a different chapter', async () => {
    getListenProgressMock.mockResolvedValueOnce({
      chapterId: 99,
      currentSec: 42,
      updatedAt: '2026-05-18T01:00:00.000Z',
    });
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await waitFor(() => expect(getListenProgressMock).toHaveBeenCalled());
    await fireLoadedMetadata(audioEl, 600);
    expect(audioEl.currentTime).toBe(0);
  });

  it('does NOT seek when the resume point sits within the last second of the chapter', async () => {
    /* Cap at d-1 — a resume parked at 599.5 in a 600 s chapter would
       trip onEnded immediately, which is worse than starting over. */
    getListenProgressMock.mockResolvedValueOnce({
      chapterId: 1,
      currentSec: 599.5,
      updatedAt: '2026-05-18T01:00:00.000Z',
    });
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await waitFor(() => expect(getListenProgressMock).toHaveBeenCalled());
    await fireLoadedMetadata(audioEl, 600);
    expect(audioEl.currentTime).toBe(0);
  });

  it('debounced save fires at the first onTimeUpdate past the 5 s threshold and not before', async () => {
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl, 600);
    /* Tick at 3 s — below threshold, no save. */
    await fireTimeUpdate(audioEl, 3);
    expect(putListenProgressMock).not.toHaveBeenCalled();
    /* Tick at 7 s — past threshold, save fires. */
    await fireTimeUpdate(audioEl, 7);
    expect(putListenProgressMock).toHaveBeenCalledWith('book-1', { chapterId: 1, currentSec: 7 });
  });

  it('flushes a final save on chapter switch when currentSec is past 5 s', async () => {
    const store = makeStore();
    const { container, rerender } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl, 600);
    await fireTimeUpdate(audioEl, 17);
    putListenProgressMock.mockClear();
    /* Switch chapters → the chapter-mount effect's cleanup fires for
       chapter 1 with the latest currentSec (17). */
    await act(async () => {
      rerender(
        <Provider store={store}>
          <MiniPlayer
            chapter={chapter2}
            bookId="book-1"
            onClose={noop}
            onPrev={noop}
            onNext={noop}
            prevAvailable={true}
            nextAvailable={false}
          />
        </Provider>,
      );
    });
    expect(putListenProgressMock).toHaveBeenCalledWith('book-1', { chapterId: 1, currentSec: 17 });
  });

  it('does NOT flush on unmount when playback stayed under the 5 s noise floor', async () => {
    const { container, unmount } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl, 600);
    /* Single tick at 2 s — never crosses the threshold, debounce save
       skips, and the cleanup must NOT fire either. */
    await fireTimeUpdate(audioEl, 2);
    putListenProgressMock.mockClear();
    await act(async () => {
      unmount();
    });
    expect(putListenProgressMock).not.toHaveBeenCalled();
  });
});

describe('MiniPlayer — plan 109 duration source of truth', () => {
  async function resolveChapterWithDuration(id: number, url: string, durationSec: number) {
    const resolver = pendingByChapter.get(id);
    if (!resolver) throw new Error(`No pending fetch for chapter ${id}`);
    await act(async () => {
      resolver({ url, durationSec, peaks: [], sampleRate: 24000, segments: [] });
    });
  }

  async function fireLoadedMetadata(audioEl: HTMLAudioElement, durationSec: number) {
    Object.defineProperty(audioEl, 'duration', { configurable: true, value: durationSec });
    await act(async () => {
      audioEl.dispatchEvent(new Event('loadedmetadata'));
    });
  }

  it('keeps the server durationSec for the scrubber total, not the inflated browser estimate', async () => {
    /* The bug: a legacy Xing-less MP3 makes the browser report a ~7x duration.
       The server's segments.json value (634 s = 10:34) is authoritative and
       must win the displayed total over the browser's 4578 s (76:18). */
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapterWithDuration(1, '/api/books/book-1/chapters/1/audio.mp3', 634);
    await fireLoadedMetadata(audioEl, 4578);

    expect(container.textContent).toContain('10:34'); // formatTime(634)
    expect(container.textContent).not.toContain('76:18'); // formatTime(4578)
  });

  it('falls back to the browser duration when the server provided none', async () => {
    const { container } = renderPlayer(
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
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapterWithDuration(1, '/api/books/book-1/chapters/1/audio.mp3', 0);
    await fireLoadedMetadata(audioEl, 600);

    expect(container.textContent).toContain('10:00'); // formatTime(600)
  });
});

describe('MiniPlayer — plan 125 live playhead → Redux', () => {
  async function fireLoadedMetadata(audioEl: HTMLAudioElement, durationSec: number) {
    Object.defineProperty(audioEl, 'duration', { configurable: true, value: durationSec });
    await act(async () => {
      audioEl.dispatchEvent(new Event('loadedmetadata'));
    });
  }
  async function fireTimeUpdate(audioEl: HTMLAudioElement, currentTimeSec: number) {
    Object.defineProperty(audioEl, 'currentTime', {
      configurable: true,
      writable: true,
      value: currentTimeSec,
    });
    await act(async () => {
      audioEl.dispatchEvent(new Event('timeupdate'));
    });
  }

  it('publishes the live playhead on timeupdate with currentSec + resolved durationSec', async () => {
    const store = makeStore();
    const { container } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    /* resolveChapter resolves with durationSec: 600 → totalSec = 600. */
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl, 600);
    await fireTimeUpdate(audioEl, 42);
    expect(store.getState().listenProgress.livePlayback).toMatchObject({
      bookId: 'book-1',
      chapterId: 1,
      currentSec: 42,
      durationSec: 600,
    });
  });

  it('throttles repeat ticks to ~2 Hz (skips a second tick within 500 ms)', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const store = makeStore();
      const { container } = render(
        <Provider store={store}>
          <MiniPlayer
            chapter={chapter1}
            bookId="book-1"
            onClose={noop}
            onPrev={noop}
            onNext={noop}
            prevAvailable={false}
            nextAvailable={true}
          />
        </Provider>,
      );
      const audioEl = container.querySelector('audio') as HTMLAudioElement;
      await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
      await fireLoadedMetadata(audioEl, 600);
      /* First tick fires (lastLiveDispatchRef starts at 0). */
      await fireTimeUpdate(audioEl, 10);
      expect(store.getState().listenProgress.livePlayback?.currentSec).toBe(10);
      /* Same wall-clock → second tick is throttled, value unchanged. */
      await fireTimeUpdate(audioEl, 11);
      expect(store.getState().listenProgress.livePlayback?.currentSec).toBe(10);
      /* Past the 500 ms window → fires again. */
      now.mockReturnValue(1_000_600);
      await fireTimeUpdate(audioEl, 12);
      expect(store.getState().listenProgress.livePlayback?.currentSec).toBe(12);
    } finally {
      now.mockRestore();
    }
  });

  it('clears the live playhead on unmount / chapter teardown', async () => {
    const store = makeStore();
    const { container, unmount } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl, 600);
    await fireTimeUpdate(audioEl, 30);
    expect(store.getState().listenProgress.livePlayback).not.toBeNull();
    await act(async () => {
      unmount();
    });
    expect(store.getState().listenProgress.livePlayback).toBeNull();
  });
});

describe('MiniPlayer — fe-24 skip forward/back', () => {
  function makeAudioWithDuration(audioEl: HTMLAudioElement, durationSec: number) {
    Object.defineProperty(audioEl, 'duration', { configurable: true, value: durationSec });
  }
  function seedCurrentTime(audioEl: HTMLAudioElement, sec: number) {
    Object.defineProperty(audioEl, 'currentTime', {
      configurable: true,
      writable: true,
      value: sec,
    });
  }
  async function fireLoadedMetadata(audioEl: HTMLAudioElement) {
    await act(async () => {
      audioEl.dispatchEvent(new Event('loadedmetadata'));
    });
  }

  it('skip-forward advances currentTime by the configured delta (default 30 s)', async () => {
    const store = makeStore();
    const { container, getByTestId } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    makeAudioWithDuration(audioEl, 600);
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl);
    /* Seed AFTER load — the audio.url effect resets currentTime to 0 on
       every src swap, so a pre-load seed would be clobbered. */
    seedCurrentTime(audioEl, 10);
    await act(async () => {
      getByTestId('mini-player-skip-forward').click();
    });
    expect(audioEl.currentTime).toBe(40);
  });

  it('skip-back from t=5 with delta 15 floors at 0', async () => {
    const store = makeStore();
    const { container, getByTestId } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    makeAudioWithDuration(audioEl, 600);
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl);
    seedCurrentTime(audioEl, 5);
    await act(async () => {
      getByTestId('mini-player-skip-back').click();
    });
    expect(audioEl.currentTime).toBe(0);
  });

  it('skip-forward clamps at the chapter duration', async () => {
    const store = makeStore();
    const { container, getByTestId } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    makeAudioWithDuration(audioEl, 600);
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await fireLoadedMetadata(audioEl);
    seedCurrentTime(audioEl, 590);
    await act(async () => {
      getByTestId('mini-player-skip-forward').click();
    });
    expect(audioEl.currentTime).toBe(600);
  });
});

describe('MiniPlayer — fe-23 auto-advance onEnded matrix', () => {
  /* Drive a fully-mounted player to the onEnded event, returning the
     onNext spy + the audio element so each case can assert advance vs.
     stop. The settings slice's autoAdvance flag is flipped via dispatch
     before the event fires. */
  async function mountAndEnd(opts: {
    autoAdvance: boolean;
    nextAvailable: boolean;
    armEndOfChapter?: boolean;
  }) {
    const store = makeStore();
    store.dispatch(settingsSlice.actions.setAutoAdvance(opts.autoAdvance));
    const onNext = vi.fn();
    const { container, getByTestId } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={onNext}
          prevAvailable={false}
          nextAvailable={opts.nextAvailable}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio') as HTMLAudioElement;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    if (opts.armEndOfChapter) {
      /* Open the sleep menu + pick end-of-chapter so the onEnded path
         sees a fired sleep timer. */
      await act(async () => {
        getByTestId('mini-player-sleep-toggle').click();
      });
      await act(async () => {
        getByTestId('mini-player-sleep-option-end-of-chapter').click();
      });
    }
    await act(async () => {
      audioEl.dispatchEvent(new Event('ended'));
    });
    return { onNext, audioEl };
  }

  it('autoAdvance=true + nextAvailable=true + sleep not fired → calls onNext and stays playing', async () => {
    const { onNext, audioEl } = await mountAndEnd({ autoAdvance: true, nextAvailable: true });
    expect(onNext).toHaveBeenCalledTimes(1);
    /* `playing` stays true: the player effect calls play() (jsdom stub),
       it never paused. The component never called setPlaying(false). */
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(audioEl).not.toBeNull();
  });

  it('nextAvailable=false → does NOT call onNext (last chapter stops)', async () => {
    const { onNext } = await mountAndEnd({ autoAdvance: true, nextAvailable: false });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('autoAdvance=false → does NOT call onNext', async () => {
    const { onNext } = await mountAndEnd({ autoAdvance: false, nextAvailable: true });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('end-of-chapter sleep timer fired → does NOT call onNext (stops)', async () => {
    const { onNext } = await mountAndEnd({
      autoAdvance: true,
      nextAvailable: true,
      armEndOfChapter: true,
    });
    expect(onNext).not.toHaveBeenCalled();
  });
});

describe('MiniPlayer — fs-16 wall-clock listening stats', () => {
  /* Helper: set currentTime on the element then dispatch timeupdate. */
  async function fireTimeUpdate(audioEl: HTMLAudioElement, currentTimeSec: number) {
    Object.defineProperty(audioEl, 'currentTime', {
      configurable: true,
      writable: true,
      value: currentTimeSec,
    });
    await act(async () => {
      audioEl.dispatchEvent(new Event('timeupdate'));
    });
  }

  it('reports wall-clock listening seconds to putListenStats on the 5 s periodic flush', async () => {
    /* Use fake timers so Date.now() is deterministic — the accumulator
       uses () => Date.now() as its clock, and the 5 s debounce gate in
       onTimeUpdate also reads Date.now(). Start at t=10 000 ms so the
       very first flush clears the lastSavedAtRef=0 gate (10000 >= 5000). */
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);

      const { container } = renderPlayer(
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
      const audioEl = container.querySelector('audio') as HTMLAudioElement;

      /* Let the chapter audio resolve so onTimeUpdate actually gates on `chapter`. */
      await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');

      /* Wait for the playing=true useEffect to fire onPlay(), then advance
         the clock by 10 s so the accumulator can attribute 10 s to today. */
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      /* Fire a timeupdate with currentTime > 5 to clear the noise guard,
         and Date.now() = 10 000 >= lastSavedAtRef(0) + 5 000, so the 5 s
         gate passes and the flush fires. */
      await fireTimeUpdate(audioEl, 7);

      expect(putListenStatsMock).toHaveBeenCalledTimes(1);
      const [calledBookId, calledBody] = (
        putListenStatsMock.mock.calls[0] as unknown
      ) as [string, { sessionId: string; days: { date: string; seconds: number }[] }];
      expect(calledBookId).toBe('book-1');
      expect(calledBody.sessionId).toBeTruthy();
      expect(calledBody.sessionId.length).toBeGreaterThan(0);
      expect(calledBody.days).toHaveLength(1);
      expect(calledBody.days[0].seconds).toBeGreaterThan(0);
      expect(calledBody.days[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MiniPlayer — volume slider (fe-25)', () => {
  it('persists the chosen volume to the settings slice and applies it to the audio element', async () => {
    const store = makeStore();
    const { container, getByTestId, queryByTestId } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio')!;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    await waitFor(() => expect(audioEl.getAttribute('src')).toMatch(/audio\.mp3$/));

    /* Slider lives inside a popover the volume button toggles open. */
    expect(queryByTestId('mini-player-volume-slider')).toBeNull();
    fireEvent.click(getByTestId('mini-player-volume-toggle'));
    const slider = getByTestId('mini-player-volume-slider') as HTMLInputElement;

    fireEvent.change(slider, { target: { value: '0.3' } });

    expect(store.getState().settings.playerVolume).toBeCloseTo(0.3);
    await waitFor(() => expect(audioEl.volume).toBeCloseTo(0.3));
  });

  it('hydrates the audio element volume from the persisted settings level on load', async () => {
    const store = makeStore();
    store.dispatch(settingsSlice.actions.setPlayerVolume(0.5));
    const { container } = render(
      <Provider store={store}>
        <MiniPlayer
          chapter={chapter1}
          bookId="book-1"
          onClose={noop}
          onPrev={noop}
          onNext={noop}
          prevAvailable={false}
          nextAvailable={true}
        />
      </Provider>,
    );
    const audioEl = container.querySelector('audio')!;
    await resolveChapter(1, '/api/books/book-1/chapters/1/audio.mp3');
    /* The url effect re-applies the saved volume after src/load. */
    await waitFor(() => expect(audioEl.volume).toBeCloseTo(0.5));
  });
});

describe('MiniPlayer — scrubber thumb touch fallback (fe-5)', () => {
  it('thumb carries the coarse-pointer reveal fallback', () => {
    const { getByTestId } = renderPlayer(
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
    const thumb = getByTestId('scrubber-thumb');
    expect(thumb).toHaveClass('coarse-pointer:opacity-100');
    expect(thumb).toHaveClass('opacity-0'); // hidden by default for mouse
    expect(thumb).toHaveClass('group-hover:opacity-100');
  });
});
