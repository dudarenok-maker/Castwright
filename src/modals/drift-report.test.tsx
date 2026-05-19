/* Pairs with docs/features/35-engine-drift-detection.md and the
   drift-report-fidelity plan.

   Covers:
     - C1+C2 auto-queueable vs manual regen pill split.
     - Chapter title is read from event.chapterTitle (no fixture join).
     - Multi-book grouping: events from two books render under separate
       book headers in a single modal.
     - Side-by-side ProfileCompareCard renders both columns and highlights
       the changed factor. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { DriftReportModal, type DriftBookGroup } from './drift-report';
import { uiSlice } from '../store/ui-slice';
import type { DriftEvent, Character, Voice } from '../lib/types';

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
  }),
}));

const getVoiceSampleSpy = vi.fn((_args: unknown) =>
  Promise.resolve({
    url: '/audio/voices/voice-eliza-kokoro-v1-cafe.mp3',
    durationSec: 12,
    cached: true,
    modelKey: 'kokoro-v1' as const,
  }),
);

vi.mock('../lib/api', () => ({
  api: {
    getVoiceSample: (args: unknown) => getVoiceSampleSpy(args),
  },
}));

const characters: Character[] = [
  { id: 'eliza', name: 'Eliza', role: 'Lead', color: 'slot-4', voiceId: 'voice-eliza' } as Character,
  { id: 'sten', name: 'Sten', role: 'Friend', color: 'slot-5' } as Character,
];

const elizaVoice: Voice = {
  id: 'voice-eliza',
  character: 'Eliza',
  attributes: [],
} as unknown as Voice;

function makeEvent(over: Partial<DriftEvent>): DriftEvent {
  return {
    id: 'drift:book-A:1:eliza:voice',
    bookId: 'book-A',
    characterId: 'eliza',
    chapterId: 1,
    chapterTitle: 'What the Captain Knew',
    severity: 'severe',
    factor: 'voice',
    factorLabel: 'Voice',
    description: 'Voice changed.',
    autoQueueable: true,
    detected: '2026-01-01T00:00:00Z',
    suggestedAction: 'regenerate_chapter',
    snapshot: { voiceId: 'old-voice', tone: { warmth: 40, pace: 50 }, attributes: ['warm'] },
    current: { voiceId: 'new-voice', tone: { warmth: 40, pace: 50 }, attributes: ['warm'] },
    ...over,
  } as DriftEvent;
}

function group(events: DriftEvent[], over: Partial<DriftBookGroup> = {}): DriftBookGroup {
  return {
    bookId: 'book-A',
    bookTitle: 'the Coalfall Commission',
    characters,
    events,
    ...over,
  };
}

describe('DriftReportModal — auto-queueable severe drift (C1+C2)', () => {
  it('renders the Auto-regen now pill for severe + autoQueueable events when the handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        eventsByBook={[group([makeEvent({})])]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const autoBtn = screen.getByTestId('drift-auto-regen-drift:book-A:1:eliza:voice');
    expect(autoBtn).toBeInTheDocument();
    expect(autoBtn).toHaveTextContent(/Auto-regen now/i);
    expect(screen.queryByTestId('drift-regen-drift:book-A:1:eliza:voice')).toBeNull();

    fireEvent.click(autoBtn);
    expect(onAutoQueueRegenerate).toHaveBeenCalledWith('book-A', 'eliza', 1);
    expect(onRegenerateChapter).not.toHaveBeenCalled();
  });

  it('renders the manual Regenerate pill for moderate events even when an autoQueueable handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        eventsByBook={[
          group([
            makeEvent({
              id: 'drift:book-A:1:eliza:pace',
              factor: 'pace',
              factorLabel: 'Pace',
              severity: 'moderate',
              autoQueueable: undefined,
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const manualBtn = screen.getByTestId('drift-regen-drift:book-A:1:eliza:pace');
    expect(manualBtn).toBeInTheDocument();
    expect(manualBtn).toHaveTextContent(/Regenerate this chapter/i);
    expect(screen.queryByTestId('drift-auto-regen-drift:book-A:1:eliza:pace')).toBeNull();

    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 1);
    expect(onAutoQueueRegenerate).not.toHaveBeenCalled();
  });

  it('falls back to the manual Regenerate pill on every event when no autoQueueable handler is provided', () => {
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        eventsByBook={[group([makeEvent({})])]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('drift-auto-regen-drift:book-A:1:eliza:voice')).toBeNull();
    const manualBtn = screen.getByTestId('drift-regen-drift:book-A:1:eliza:voice');
    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 1);
  });

  it('groups severe + moderate events under separate severity headings (regression for the existing layout)', () => {
    const onAutoQueueRegenerate = vi.fn();
    render(
      <DriftReportModal
        eventsByBook={[
          group([
            makeEvent({}),
            makeEvent({
              id: 'drift:book-A:1:sten:pace',
              characterId: 'sten',
              factor: 'pace',
              factorLabel: 'Pace',
              severity: 'moderate',
              autoQueueable: undefined,
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('drift-auto-regen-drift:book-A:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-regen-drift:book-A:1:sten:pace')).toBeInTheDocument();
  });
});

describe('DriftReportModal — fidelity contract (drift-report-fidelity plan)', () => {
  it('renders the chapter title from event.chapterTitle, not a fixture', () => {
    /* Pre-fix the modal joined against initialChapters from src/data/chapters.ts
       so "What the Captain Knew" surfaced even when the live book had no such
       chapter. Now the title comes off the event payload, server-emitted. */
    render(
      <DriftReportModal
        eventsByBook={[
          group([
            makeEvent({
              chapterTitle: 'A Real Chapter Title',
              chapterId: 42,
              id: 'drift:book-A:42:eliza:voice',
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* chapter title prefix-stripped in `stripChapterPrefix` — bare title remains. */
    expect(screen.getByText(/A Real Chapter Title/)).toBeInTheDocument();
    /* No fixture chapter title leaks through. */
    expect(screen.queryByText(/What the Captain Knew/)).toBeNull();
  });

  it('renders a book header per group when more than one book has drift', () => {
    render(
      <DriftReportModal
        eventsByBook={[
          group([makeEvent({})], { bookId: 'book-A', bookTitle: 'Book Aleph' }),
          group(
            [
              makeEvent({
                id: 'drift:book-B:1:sten:voice',
                bookId: 'book-B',
                characterId: 'sten',
              }),
            ],
            { bookId: 'book-B', bookTitle: 'Book Beth' },
          ),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Book Aleph')).toBeInTheDocument();
    expect(screen.getByText('Book Beth')).toBeInTheDocument();
    /* Header summary counts across books. */
    expect(screen.getByText(/2 chapters flagged across 2 books/)).toBeInTheDocument();
  });

  it('omits the book sub-header when only one book has drift', () => {
    render(
      <DriftReportModal
        eventsByBook={[group([makeEvent({})], { bookTitle: 'the Coalfall Commission' })]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Header summary collapses to today's "{N} chapter(s) flagged" form when
       only one book is involved. */
    expect(screen.getByText(/1 chapter flagged/)).toBeInTheDocument();
    /* The single-book optimisation hides the redundant sub-header — the modal
       title bar already names the surface. */
    expect(screen.queryByText('the Coalfall Commission')).toBeNull();
  });

  it('renders the side-by-side comparison with both When rendered and Now columns', () => {
    render(
      <DriftReportModal
        eventsByBook={[
          group([
            makeEvent({
              snapshot: {
                voiceId: 'af_sarah',
                gender: 'female',
                ageRange: 'adult',
                tone: { warmth: 45, pace: 50, authority: 50, emotion: 50 },
                attributes: ['warm', 'calm'],
              },
              current: {
                voiceId: 'af_nova',
                gender: 'female',
                ageRange: 'adult',
                tone: { warmth: 75, pace: 50, authority: 50, emotion: 50 },
                attributes: ['warm', 'calm', 'enthusiastic'],
              },
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('When rendered')).toBeInTheDocument();
    expect(screen.getByText('Now')).toBeInTheDocument();
    /* All major profile rows render — regression guard that the table
       doesn't silently lose rows when one factor is undefined. */
    expect(screen.getByTestId('drift-compare-row-voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-compare-row-warmth')).toBeInTheDocument();
    expect(screen.getByTestId('drift-compare-row-attributes')).toBeInTheDocument();
  });

  it('marks the changed-factor row with data-changed=true', () => {
    render(
      <DriftReportModal
        eventsByBook={[
          group([
            makeEvent({
              factor: 'warmth',
              snapshot: { tone: { warmth: 30 } },
              current: { tone: { warmth: 70 } },
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('drift-compare-row-warmth')).toHaveAttribute(
      'data-changed',
      'true',
    );
    expect(screen.getByTestId('drift-compare-row-pace')).toHaveAttribute(
      'data-changed',
      'false',
    );
  });
});

/* Bug 8 — Listen button A/B player. */
describe('DriftReportModal — Listen A/B compare player (bug 8)', () => {
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let playASpy: ReturnType<typeof vi.spyOn>;
  let pauseASpy: ReturnType<typeof vi.spyOn>;
  let playBSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    playSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    pauseSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {});
    playASpy = playSpy;
    pauseASpy = pauseSpy;
    playBSpy = playSpy;
    getVoiceSampleSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function renderModalWithVoices(events: DriftEvent[]) {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    return render(
      <Provider store={store}>
        <DriftReportModal
          eventsByBook={[group(events, { bookId: 'b-keeper' })]}
          voices={[elizaVoice]}
          onClose={vi.fn()}
          onRegenerateChapter={vi.fn()}
          onDismiss={vi.fn()}
        />
      </Provider>,
    );
  }

  it('Listen button toggles inline A/B controls visible', () => {
    renderModalWithVoices([makeEvent({})]);
    const listenBtn = screen.getByTestId('drift-listen-drift:book-A:1:eliza:voice');
    expect(screen.queryByTestId('drift-play-chapter-drift:book-A:1:eliza:voice')).toBeNull();
    expect(screen.queryByTestId('drift-play-voice-drift:book-A:1:eliza:voice')).toBeNull();
    fireEvent.click(listenBtn);
    expect(
      screen.getByTestId('drift-play-chapter-drift:book-A:1:eliza:voice'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('drift-play-voice-drift:book-A:1:eliza:voice'),
    ).toBeInTheDocument();
  });

  it('Play chapter calls .play() on the chapter audio element', () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:book-A:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:book-A:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalled();
  });

  it('Play voice fetches the sample URL on first click and plays it', async () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:book-A:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-voice-drift:book-A:1:eliza:voice'));
    await waitFor(() => expect(getVoiceSampleSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(playBSpy).toHaveBeenCalled());
  });

  it('starting B while A is playing pauses A first (mutex)', async () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:book-A:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:book-A:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('drift-play-voice-drift:book-A:1:eliza:voice'));
    await waitFor(() => expect(playBSpy).toHaveBeenCalled());
    expect(pauseASpy).toHaveBeenCalled();
  });

  it('closing the modal pauses both audio elements (cleanup)', () => {
    const { unmount } = renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:book-A:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:book-A:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalled();
    pauseASpy.mockClear();
    unmount();
    expect(pauseASpy).toHaveBeenCalled();
  });
});
