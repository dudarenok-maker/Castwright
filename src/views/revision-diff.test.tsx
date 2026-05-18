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
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
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

function renderPlayer(revision: Revision = makeRevision()) {
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
});
