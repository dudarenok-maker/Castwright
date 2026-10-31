/* RevisionDiffPlayer — a/b audio audition.

   Covers the plan-20 invariants we just shipped:
   - Mutual exclusion: playing A stops B and vice versa.
   - playable=false: B controls are disabled and the "Rendering new take…"
     copy renders.
   - hasPreviousAudio=false: A controls are disabled and the
     "Original audio not preserved" copy renders.
   - Audio URLs come from `api.getChapterAudio` (B) and
     `api.getChapterAudioPrevious` (A).

   jsdom doesn't implement HTMLMediaElement, so we spy on the prototype's
   `play` / `pause` to assert mutual exclusion. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { RevisionDiffPlayer } from './revision-diff';
import type { Revision, Chapter, Character, ChapterAudio } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getChapterAudio: vi.fn(),
    getChapterAudioPrevious: vi.fn(),
  },
}));
import { api } from '../lib/api';

const chapter: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:30',
  state: 'done',
  progress: 1,
  characters: { halloran: 'done' },
};

const character: Character = {
  id: 'halloran',
  name: 'Halloran',
  role: 'PoV',
  color: 'narrator',
};

const makeRevision = (overrides: Partial<Revision> = {}): Revision => ({
  id: 'rev1',
  chapterId: 1,
  characterId: 'halloran',
  triggeredBy: 'voice change',
  triggeredAgo: 'just now',
  oldDuration: '00:30',
  newDuration: '00:31',
  confidence: 0.92,
  playable: true,
  hasPreviousAudio: true,
  segments: [],
  ...overrides,
});

const audioMeta = (url: string): ChapterAudio => ({
  url,
  durationSec: 30,
  peaks: [],
  sampleRate: 44100,
  segments: [],
});

/* jsdom doesn't implement HTMLMediaElement.play/pause — stub them so
   neither the hook's cleanup nor a play click logs a noisy
   "Not implemented" warning. Individual tests can re-spy with
   vi.spyOn() to assert call counts. */
let basePlay: ReturnType<typeof vi.spyOn>;
let basePause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  (api.getChapterAudio as ReturnType<typeof vi.fn>).mockResolvedValue(audioMeta('blob:b'));
  (api.getChapterAudioPrevious as ReturnType<typeof vi.fn>).mockResolvedValue(audioMeta('blob:a'));
  basePlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true, writable: true });
    return Promise.resolve();
  });
  basePause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true, writable: true });
  });
});

afterEach(() => {
  cleanup();
  basePlay.mockRestore();
  basePause.mockRestore();
});

function renderPlayer(
  revision: Revision = makeRevision(),
  extra: Partial<React.ComponentProps<typeof RevisionDiffPlayer>> = {},
) {
  const onClose = vi.fn();
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const result = render(
    <RevisionDiffPlayer
      revision={revision}
      bookId="book-1"
      chapter={chapter}
      character={character}
      onClose={onClose}
      onAccept={onAccept}
      onReject={onReject}
      {...extra}
    />,
  );
  return { ...result, onClose, onAccept, onReject };
}

describe('RevisionDiffPlayer', () => {
  it('fetches both A (previous) and B (current) audio on mount', async () => {
    renderPlayer();
    await waitFor(() => {
      expect(api.getChapterAudioPrevious).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 'book-1', chapterId: 1 }),
      );
      expect(api.getChapterAudio).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 'book-1', chapterId: 1 }),
      );
    });
  });

  it('mutual exclusion: clicking B pauses A', async () => {
    renderPlayer();
    await waitFor(() => {
      expect(api.getChapterAudio).toHaveBeenCalled();
    });

    /* Both A and B play buttons live on the ABCards. Use aria-label
       (set by the play button) to disambiguate. */
    const playA = await screen.findByLabelText(/Play A · Current/i);
    const playB = await screen.findByLabelText(/Play B · New draft/i);

    /* Track call counts on the base spies installed in beforeEach. */
    const playsBeforeA = basePlay.mock.calls.length;
    fireEvent.click(playA);
    await waitFor(() => expect(basePlay.mock.calls.length).toBeGreaterThan(playsBeforeA));
    const pausesAfterA = basePause.mock.calls.length;
    const playsAfterA = basePlay.mock.calls.length;

    fireEvent.click(playB);
    /* Click B triggers playVersion('B') which first pauses 'A' (the
       "other" element) and then plays the new target. */
    await waitFor(() => {
      expect(basePause.mock.calls.length).toBeGreaterThan(pausesAfterA);
      expect(basePlay.mock.calls.length).toBeGreaterThan(playsAfterA);
    });
  });

  it('disables B controls when playable=false and renders the rendering copy', () => {
    renderPlayer(makeRevision({ playable: false }));
    expect(screen.getByText(/Rendering new take/)).toBeInTheDocument();
    const playB = screen.getByLabelText(/Play B · New draft/i);
    expect(playB).toBeDisabled();
    /* Auto-compare button also disabled — there's nothing to compare to. */
    expect(screen.getByRole('button', { name: /Listen back-to-back/i })).toBeDisabled();
  });

  it('disables A controls and renders "Original audio not preserved" when hasPreviousAudio=false', () => {
    renderPlayer(makeRevision({ hasPreviousAudio: false }));
    expect(screen.getByText(/Original audio not preserved/)).toBeInTheDocument();
    const playA = screen.getByLabelText(/Play A · Current/i);
    expect(playA).toBeDisabled();
    /* Crucially, the previous-audio fetch is skipped — saves a 404
       round trip when the server already told us nothing's preserved. */
    expect(api.getChapterAudioPrevious).not.toHaveBeenCalled();
  });

  it('calls onAccept with the captured selection map when Commit selection clicks', () => {
    const { onAccept } = renderPlayer(
      makeRevision({
        segments: [
          {
            id: 1,
            text: 'Hello.',
            changed: true,
            oldDuration: '00:01',
            newDuration: '00:01',
            narratorOnly: false,
          },
          {
            id: 2,
            text: 'World.',
            changed: false,
            oldDuration: '00:01',
            newDuration: '00:01',
            narratorOnly: false,
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Commit selection/i }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    /* Initial selection: changed segments → 'B', unchanged → 'A'. */
    const selection = onAccept.mock.calls[0][0] as Record<number, 'A' | 'B'>;
    expect(selection).toEqual({ 1: 'B', 2: 'A' });
  });

  it('calls onReject when "Reject draft" clicks', () => {
    const { onReject } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  /* fs-32b (#503) — a splice revision (loudness / per-character re-record) lands
     with an EMPTY segments array. The A/B player must render without crashing
     (no unchecked segments[0] / .map on undefined) and simply omit the
     per-segment diff panel. */
  it('renders a splice revision with empty segments[] without throwing', async () => {
    expect(() =>
      renderPlayer(
        makeRevision({
          segments: [],
          triggeredBy: 'Loudness fix (Halloran)',
        }),
      ),
    ).not.toThrow();
    /* The per-segment diff list is gated on segments.length > 0, so its panel
       header ("N segments changed · M taking B") stays out of the DOM — but the
       player chrome (Reject draft) is present. */
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeInTheDocument();
    expect(screen.queryByText(/taking B/i)).toBeNull();
    /* Both audio fetches still fire — there's a take to audition even though no
       segment-level diff exists. */
    await waitFor(() => {
      expect(api.getChapterAudio).toHaveBeenCalled();
    });
  });

  it('plan 286 — busy disables every footer action', () => {
    renderPlayer(makeRevision(), { busy: true });
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Commit selection/i })).toBeDisabled();
  });
  it('plan 286 — rendering shows the rendering copy and disables B', () => {
    renderPlayer(makeRevision(), { rendering: true });
    expect(screen.getByText(/Rendering new take/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Play B · New draft/i)).toBeDisabled();
  });
  it('plan 286 — A unavailable: Keep new take replaces Commit selection; Reject is disabled', () => {
    const onKeepNew = vi.fn();
    renderPlayer(makeRevision(), { previousMissing: true, onKeepNew });
    expect(screen.queryByRole('button', { name: /Commit selection/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Keep new take/i }));
    expect(onKeepNew).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Reject draft/i })).toBeDisabled();
  });
  it('plan 286 — preview mode never shows Keep new take', () => {
    render(<RevisionDiffPlayer revision={makeRevision({ hasPreviousAudio: false })} bookId="book-1" chapter={chapter} character={character}
      onClose={vi.fn()} onAccept={vi.fn()} onReject={vi.fn()} onKeepNew={vi.fn()} mode="preview" />);
    expect(screen.queryByRole('button', { name: /Keep new take/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Approve.*regenerate the rest/i })).toBeEnabled();
  });
  it('plan 286 — releases both audio elements before calling onReject', () => {
    const order: string[] = [];
    basePause.mockImplementation(function (this: HTMLMediaElement) { order.push('pause'); });
    const onReject = vi.fn(() => { order.push('reject'); });
    renderPlayer(makeRevision(), { onReject });
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i }));
    expect(order.filter((o) => o === 'pause').length).toBeGreaterThanOrEqual(2);
    expect(order.lastIndexOf('pause')).toBeLessThan(order.indexOf('reject'));
  });
  it('plan 286 — after a refused reject (player still open), A and B still play from their URLs', async () => {
    const played: Array<string | null> = [];
    basePlay.mockImplementation(function (this: HTMLMediaElement) { played.push(this.getAttribute('src')); return Promise.resolve(); });
    renderPlayer(makeRevision());
    await waitFor(() => expect(api.getChapterAudio).toHaveBeenCalled());
    await waitFor(() => expect(api.getChapterAudioPrevious).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); }); // let setAudioA/setAudioB land so the hook has both URLs
    fireEvent.click(screen.getByRole('button', { name: /Reject draft/i })); // release; onReject is a no-op mock = refused
    fireEvent.click(screen.getByLabelText(/Play A · Current/i));
    fireEvent.click(screen.getByLabelText(/Play B · New draft/i));
    await waitFor(() => expect(played).toEqual(['blob:a', 'blob:b']));
  });
  it('plan 286 (OD20) — a recovered entry is labelled, and its A side is described as the kept take', () => {
    renderPlayer(makeRevision({ recovered: true }));
    expect(screen.getByTestId('revision-recovered-badge')).toHaveTextContent('Recovered from before the update');
    expect(screen.getByText("The take kept before this chapter's last render")).toBeInTheDocument();
    expect(screen.queryByText('Already in your audiobook')).toBeNull();
  });
  it('plan 286 (OD20) — an ordinary entry shows no recovered label', () => {
    renderPlayer(makeRevision());
    expect(screen.queryByTestId('revision-recovered-badge')).toBeNull();
    expect(screen.getByText('Already in your audiobook')).toBeInTheDocument();
  });
  it('#4002 — Listen back-to-back waits for each take to end before starting the next', async () => {
    const played: Array<{ src: string | null; el: HTMLMediaElement }> = [];
    basePlay.mockImplementation(function (this: HTMLMediaElement) {
      played.push({ src: this.getAttribute('src'), el: this });
      return Promise.resolve();
    });
    const seg = (id: number) => ({ id, changed: true }) as unknown as Revision['segments'][number];
    renderPlayer(makeRevision({ segments: [seg(1), seg(2)] }));
    await waitFor(() => expect(api.getChapterAudio).toHaveBeenCalled());
    await waitFor(() => expect(api.getChapterAudioPrevious).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); }); // let both URLs land in the hook
    fireEvent.click(screen.getByRole('button', { name: /Listen back-to-back/i }));
    await waitFor(() => expect(played.map((p) => p.src)).toEqual(['blob:a']));
    /* The first take is still playing: several poll ticks later nothing else may start. */
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(played.map((p) => p.src)).toEqual(['blob:a']);
    /* It ends, and only then does B start. */
    await act(async () => { played[0].el.dispatchEvent(new Event('ended')); });
    await waitFor(() => expect(played.map((p) => p.src)).toEqual(['blob:a', 'blob:b']));
  });
  it('#4002 — Listen back-to-back is held until both segment sets are loaded', async () => {
    let resolveA!: (v: ChapterAudio) => void;
    let resolveB!: (v: ChapterAudio) => void;
    (api.getChapterAudioPrevious as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<ChapterAudio>((r) => (resolveA = r)),
    );
    (api.getChapterAudio as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<ChapterAudio>((r) => (resolveB = r)),
    );
    const seg = { id: 1, changed: true } as unknown as Revision['segments'][number];
    renderPlayer(makeRevision({ segments: [seg] }));
    const toggle = screen.getByRole('button', { name: /Listen back-to-back/i });
    expect(toggle).toBeDisabled();
    await act(async () => { resolveA(audioMeta('blob:a')); });
    expect(toggle).toBeDisabled(); // B still pending
    await act(async () => { resolveB(audioMeta('blob:b')); });
    expect(toggle).toBeEnabled();
  });
  it('#4002 — Listen back-to-back stays usable when a take metadata fails to load', async () => {
    (api.getChapterAudioPrevious as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('404'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seg = { id: 1, changed: true } as unknown as Revision['segments'][number];
    renderPlayer(makeRevision({ segments: [seg] }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Listen back-to-back/i })).toBeEnabled(),
    );
    warn.mockRestore();
  });
  it('#4002 — Listen back-to-back reads segment windows from the metadata current at each take', async () => {
    const played: Array<{ src: string | null; at: number; el: HTMLMediaElement }> = [];
    basePlay.mockImplementation(function (this: HTMLMediaElement) {
      played.push({ src: this.getAttribute('src'), at: this.currentTime, el: this });
      return Promise.resolve();
    });
    const withSegs = (url: string, starts: number[]): ChapterAudio => ({
      ...audioMeta(url),
      segments: starts.map((start, i) => ({ sentenceId: i + 1, start, end: start + 1 })),
    });
    const getA = api.getChapterAudioPrevious as ReturnType<typeof vi.fn>;
    const getB = api.getChapterAudio as ReturnType<typeof vi.fn>;
    getA.mockResolvedValue(withSegs('blob:a', [1, 3]));
    getB.mockResolvedValue(withSegs('blob:b', [10, 12]));
    const seg = (id: number) => ({ id, changed: true }) as unknown as Revision['segments'][number];
    const revision = makeRevision({ segments: [seg(1), seg(2)] });
    const view = renderPlayer(revision);
    const toggle = screen.getByRole('button', { name: /Listen back-to-back/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0].at).toBe(1);
    /* The chapter object changes mid-run, so both takes are re-fetched and the
       metadata the effect must use is no longer the one it started with. */
    getA.mockResolvedValue(withSegs('blob:a2', [5, 7]));
    getB.mockResolvedValue(withSegs('blob:b2', [20, 22]));
    view.rerender(
      <RevisionDiffPlayer
        revision={revision}
        bookId="book-1"
        chapter={{ ...chapter }}
        character={character}
        onClose={view.onClose}
        onAccept={view.onAccept}
        onReject={view.onReject}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { played[0].el.dispatchEvent(new Event('ended')); });
    await waitFor(() => expect(played).toHaveLength(2));
    expect(played[1].at).toBe(20); // B, segment 1, from the re-fetched metadata
    await act(async () => { played[1].el.dispatchEvent(new Event('ended')); });
    await waitFor(() => expect(played).toHaveLength(3));
    expect(played[2].at).toBe(7); // A, segment 2, from the re-fetched metadata
  });
  it('#4002 — a stale take-load failure does not enable Listen back-to-back while the chapter refetches', async () => {
    const getA = api.getChapterAudioPrevious as ReturnType<typeof vi.fn>;
    getA.mockRejectedValue(new Error('404'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seg = { id: 1, changed: true } as unknown as Revision['segments'][number];
    const revision = makeRevision({ segments: [seg] });
    const view = renderPlayer(revision);
    const toggle = screen.getByRole('button', { name: /Listen back-to-back/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    getA.mockReturnValue(new Promise<ChapterAudio>(() => {})); // refetch stays pending
    view.rerender(
      <RevisionDiffPlayer
        revision={revision}
        bookId="book-1"
        chapter={{ ...chapter }}
        character={character}
        onClose={view.onClose}
        onAccept={view.onAccept}
        onReject={view.onReject}
      />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(toggle).toBeDisabled();
    warn.mockRestore();
  });
  describe('a take with no URL (#4002)', () => {
    /* Chromium leaves play() pending on an element with no src. */
    function browserLikePlay() {
      const played: Array<{ src: string | null; at: number; el: HTMLMediaElement }> = [];
      basePlay.mockImplementation(function (this: HTMLMediaElement) {
        const src = this.getAttribute('src');
        played.push({ src, at: this.currentTime, el: this });
        return src ? Promise.resolve() : new Promise<void>(() => {});
      });
      return played;
    }
    const seg = (id: number) => ({ id, changed: true }) as unknown as Revision['segments'][number];
    const getA = () => api.getChapterAudioPrevious as ReturnType<typeof vi.fn>;
    const getB = () => api.getChapterAudio as ReturnType<typeof vi.fn>;
    const toggleBtn = () => screen.getByRole('button', { name: /Listen back-to-back|Stop/i });

    it('skips A and plays B when A failed to load', async () => {
      const played = browserLikePlay();
      getA().mockRejectedValue(new Error('404'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderPlayer(makeRevision({ segments: [seg(1)] }));
      await waitFor(() => expect(toggleBtn()).toBeEnabled());
      fireEvent.click(toggleBtn());
      await waitFor(() => expect(played.map((p) => p.src)).toEqual(['blob:b']));
      warn.mockRestore();
    });

    it('skips A and plays B when A resolves null (its 404 path)', async () => {
      const played = browserLikePlay();
      getA().mockResolvedValue(null);
      renderPlayer(makeRevision({ segments: [seg(1)] }));
      await waitFor(() => expect(toggleBtn()).toBeEnabled());
      fireEvent.click(toggleBtn());
      await waitFor(() => expect(played.map((p) => p.src)).toEqual(['blob:b']));
    });

    it('skips B but still plays the next segment when B failed to load', async () => {
      const played = browserLikePlay();
      getB().mockRejectedValue(new Error('boom'));
      renderPlayer(makeRevision({ segments: [seg(1), seg(2)] }));
      await waitFor(() => expect(toggleBtn()).toBeEnabled());
      fireEvent.click(toggleBtn());
      await waitFor(() => expect(played).toHaveLength(1));
      await act(async () => { played[0].el.dispatchEvent(new Event('ended')); });
      await waitFor(() => expect(played.map((p) => p.src)).toEqual(['blob:a', 'blob:a']));
    });

    it('treats a failed B load as settled, and clears it when the chapter refetches', async () => {
      getB().mockRejectedValue(new Error('boom'));
      const revision = makeRevision({ segments: [seg(1)] });
      const view = renderPlayer(revision);
      await waitFor(() => expect(toggleBtn()).toBeEnabled());
      getB().mockReturnValue(new Promise<ChapterAudio>(() => {}));
      view.rerender(
        <RevisionDiffPlayer
          revision={revision}
          bookId="book-1"
          chapter={{ ...chapter }}
          character={character}
          onClose={view.onClose}
          onAccept={view.onAccept}
          onReject={view.onReject}
        />,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(toggleBtn()).toBeDisabled();
    });

    it('keeps Stop enabled during a run even when a chapter refetch is pending', async () => {
      browserLikePlay();
      getA().mockRejectedValue(new Error('404'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const revision = makeRevision({ segments: [seg(1)] });
      const view = renderPlayer(revision);
      await waitFor(() => expect(toggleBtn()).toBeEnabled());
      fireEvent.click(toggleBtn());
      expect(toggleBtn()).toHaveTextContent(/Stop/);
      getA().mockReturnValue(new Promise<ChapterAudio>(() => {}));
      view.rerender(
        <RevisionDiffPlayer
          revision={revision}
          bookId="book-1"
          chapter={{ ...chapter }}
          character={character}
          onClose={view.onClose}
          onAccept={view.onAccept}
          onReject={view.onReject}
        />,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(toggleBtn()).toBeEnabled();
      fireEvent.click(toggleBtn());
      expect(toggleBtn()).toHaveTextContent(/Listen back-to-back/);
      warn.mockRestore();
    });

    it('says why the toggle is disabled while the takes load', async () => {
      getA().mockReturnValue(new Promise<ChapterAudio>(() => {}));
      renderPlayer(makeRevision({ segments: [seg(1)] }));
      const btn = toggleBtn();
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Loading both takes…');
      expect(screen.getByText('Loading both takes…')).toBeInTheDocument();
      expect(btn).toHaveAccessibleDescription('Loading both takes…');
    });
  });
});
