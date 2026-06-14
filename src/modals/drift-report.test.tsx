/* Pairs with docs/features/archive/35-engine-drift-detection.md and the
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
import { DriftReportModal, type DriftBookGroupView } from './drift-report';
import { uiSlice } from '../store/ui-slice';
import { groupDriftEvents } from '../store/revisions-slice';
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

function group(events: DriftEvent[], over: Partial<DriftBookGroupView> = {}): DriftBookGroupView {
  return {
    bookId: 'book-A',
    bookTitle: 'the Coalfall Commission',
    characters,
    groups: groupDriftEvents(events),
    ...over,
  };
}

describe('DriftReportModal — auto-queueable severe drift (C1+C2)', () => {
  it('renders the Auto-regen now pill for severe + autoQueueable events when the handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[group([makeEvent({})])]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const autoBtn = screen.getByTestId('drift-auto-regen-drift:book-A:1:eliza:voice');
    expect(autoBtn).toBeInTheDocument();
    expect(autoBtn).toHaveTextContent(/Auto-regen/i);
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
        groupsByBook={[
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
    expect(manualBtn).toHaveTextContent(/Regenerate/i);
    expect(screen.queryByTestId('drift-auto-regen-drift:book-A:1:eliza:pace')).toBeNull();

    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 1);
    expect(onAutoQueueRegenerate).not.toHaveBeenCalled();
  });

  it('falls back to the manual Regenerate pill on every event when no autoQueueable handler is provided', () => {
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[group([makeEvent({})])]}
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
        groupsByBook={[
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
        groupsByBook={[
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
        groupsByBook={[
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

  it('renders the book sub-header even when only one book has drift', () => {
    render(
      <DriftReportModal
        groupsByBook={[group([makeEvent({})], { bookTitle: 'the Coalfall Commission' })]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Header summary collapses to today's "{N} chapter(s) flagged" form when
       only one book is involved — the "across N books" suffix is still gated
       on bookCount > 1. */
    expect(screen.getByText(/1 chapter flagged/)).toBeInTheDocument();
    expect(screen.queryByText(/across .* books/)).toBeNull();
    /* The book sub-header is always rendered so the user can tell which book
       any given cast card belongs to — the modal can be opened from any view
       and may surface drift from a non-active book. */
    expect(screen.getByText('the Coalfall Commission')).toBeInTheDocument();
  });

  it('renders the side-by-side comparison with both When rendered and Now columns', () => {
    render(
      <DriftReportModal
        groupsByBook={[
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
        groupsByBook={[
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
          groupsByBook={[group(events, { bookId: 'b-keeper' })]}
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

/* Cast Drift consolidation (plan 91) — one card per
   `(book × character × snapshot)` group, redundant compare table
   deduped, per-chapter strip + bulk actions for multi-chapter groups.
   Backstop for the 300-event hang the user reported. */
describe('DriftReportModal — consolidated (book × character × snapshot) groups (plan 91)', () => {
  /* Two snapshots — same character, before & after a mid-book cast edit. */
  const snapA: DriftEvent['snapshot'] = {
    voiceId: 'old-voice',
    tone: { warmth: 40, pace: 50 },
    attributes: ['warm'],
  };
  const snapB: DriftEvent['snapshot'] = {
    voiceId: 'second-old-voice',
    tone: { warmth: 40, pace: 50 },
    attributes: ['warm'],
  };
  const cur: DriftEvent['current'] = {
    voiceId: 'new-voice',
    tone: { warmth: 80, pace: 50 },
    attributes: ['warm', 'enthusiastic'],
  };

  function makeChapterEvent(chapterId: number, over: Partial<DriftEvent> = {}): DriftEvent {
    return makeEvent({
      id: `drift:book-A:${chapterId}:eliza:voice`,
      chapterId,
      chapterTitle: `Chapter ${chapterId}`,
      snapshot: snapA,
      current: cur,
      ...over,
    });
  }

  it('collapses N same-snapshot events into a single card with the compare table rendered once', () => {
    render(
      <DriftReportModal
        groupsByBook={[
          group([makeChapterEvent(1), makeChapterEvent(2), makeChapterEvent(3)]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Three events → one group → one compare card. The 8 row testids
       collapse to single occurrences. */
    expect(screen.getAllByTestId('drift-compare-row-voice')).toHaveLength(1);
    /* Card chapter count + modal header "3 chapters flagged" both
       contain the substring — at minimum the card surface must show
       its chapter count. */
    expect(screen.getAllByText(/3 chapters/i).length).toBeGreaterThanOrEqual(1);
  });

  it('splits two snapshots for the same character into two cards (mid-book cast edit)', () => {
    render(
      <DriftReportModal
        groupsByBook={[
          group([
            makeChapterEvent(1, { snapshot: snapA }),
            makeChapterEvent(2, { snapshot: snapA }),
            makeChapterEvent(3, { snapshot: snapB }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Two snapshots → two cards → two compare tables. */
    expect(screen.getAllByTestId('drift-compare-row-voice')).toHaveLength(2);
  });

  it('a single-chapter group renders its action row inline (no expand button needed)', () => {
    render(
      <DriftReportModal
        groupsByBook={[group([makeChapterEvent(1)])]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Single-chapter optimisation — no Show-N toggle, no Regen-all
       (single-chapter regen-all would just duplicate the inline button). */
    expect(screen.queryByTestId(/^drift-group-toggle-/)).toBeNull();
    expect(screen.queryByTestId(/^drift-group-regen-all-/)).toBeNull();
    /* The single-chapter row still surfaces auto-regen + dismiss. */
    expect(screen.getByTestId('drift-auto-regen-drift:book-A:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-dismiss-drift:book-A:1:eliza:voice')).toBeInTheDocument();
  });

  it('a multi-chapter group keeps the chapters strip collapsed by default', () => {
    render(
      <DriftReportModal
        groupsByBook={[group([makeChapterEvent(1), makeChapterEvent(2)])]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Collapsed by default → chapter rows hidden, toggle visible. */
    expect(screen.queryByTestId(/^drift-event-drift:book-A:1:eliza/)).toBeNull();
    const toggle = screen.getByText(/Show 2 chapters/i);
    fireEvent.click(toggle);
    /* After expand, both chapter rows are visible. */
    expect(screen.getByTestId('drift-event-drift:book-A:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-event-drift:book-A:2:eliza:voice')).toBeInTheDocument();
  });

  it('Regenerate all fires onRegenerateChapter once per chapter in the group', () => {
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[
          group([makeChapterEvent(1), makeChapterEvent(2), makeChapterEvent(3)]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onDismiss={vi.fn()}
      />,
    );
    const regenAll = screen.getByTestId(/^drift-group-regen-all-/);
    fireEvent.click(regenAll);
    expect(onRegenerateChapter).toHaveBeenCalledTimes(3);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 1);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 2);
    expect(onRegenerateChapter).toHaveBeenCalledWith('book-A', 'eliza', 3);
  });

  it('Auto-regen all is only present when every event in the group is autoQueueable', () => {
    const onAutoQueueRegenerate = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[
          group([
            makeChapterEvent(1, { autoQueueable: true }),
            makeChapterEvent(2, { autoQueueable: false }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    /* Mixed autoQueueable → no bulk auto-regen surface. */
    expect(screen.queryByTestId(/^drift-group-auto-regen-all-/)).toBeNull();
  });

  it('Auto-regen all fires onAutoQueueRegenerate once per chapter when all are autoQueueable', () => {
    const onAutoQueueRegenerate = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[
          group([
            makeChapterEvent(1, { autoQueueable: true }),
            makeChapterEvent(2, { autoQueueable: true }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const autoAll = screen.getByTestId(/^drift-group-auto-regen-all-/);
    fireEvent.click(autoAll);
    expect(onAutoQueueRegenerate).toHaveBeenCalledTimes(2);
  });

  it('Dismiss all fires onDismiss once per event in the group', () => {
    const onDismiss = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[
          group([makeChapterEvent(1), makeChapterEvent(2), makeChapterEvent(3)]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId(/^drift-group-dismiss-all-/));
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  it('header summary counts unique chapters across every group', () => {
    /* The "{N} chapters flagged" line in the modal header counts unique
       chapters (post-correction; the pre-correction shape that counted
       per-factor events is preserved as an archive note on plan 91). */
    render(
      <DriftReportModal
        groupsByBook={[
          group([
            makeChapterEvent(1, { snapshot: snapA }),
            makeChapterEvent(2, { snapshot: snapA }),
            makeChapterEvent(3, { snapshot: snapB }),
            makeChapterEvent(4, { snapshot: snapB }),
            makeChapterEvent(5, { snapshot: snapB }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/5 chapters flagged/)).toBeInTheDocument();
    /* Only 2 cards though — one per snapshot. */
    expect(screen.getAllByTestId(/^drift-group-/).length).toBeGreaterThanOrEqual(2);
  });

  it('counts a chapter once when two different cast members drift in it', () => {
    /* The Everblaze bug: chapter 5 drifts for BOTH Eliza and Sten — two
       separate per-character groups. Pre-fix the header summed each group's
       chapter list → "2 chapters flagged" for what is a single regeneration
       (regenerating chapter 5 clears drift for all cast in it). Must read 1. */
    render(
      <DriftReportModal
        groupsByBook={[
          group([
            makeEvent({
              id: 'drift:book-A:5:eliza:voice',
              characterId: 'eliza',
              chapterId: 5,
              snapshot: { voiceId: 'eliza-old', tone: { warmth: 40, pace: 50 }, attributes: [] },
            }),
            makeEvent({
              id: 'drift:book-A:5:sten:voice',
              characterId: 'sten',
              chapterId: 5,
              snapshot: { voiceId: 'sten-old', tone: { warmth: 60, pace: 50 }, attributes: [] },
            }),
          ]),
        ]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Header dedupes across characters → 1, even though there are 2 cards. */
    expect(screen.getByText(/1 chapter flagged/)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^drift-group-/).length).toBeGreaterThanOrEqual(2);
  });

  /* Regression for the Voice Drift Detector "duplicated chapter rows"
     bug — multi-factor events on the same chapter must collapse to one
     row in the chapter strip, and the header count must reflect unique
     chapters, not per-factor events. */
  it('dedupes multi-factor events on the same chapter to one row + unique-chapter header count', () => {
    const onRegenerateChapter = vi.fn();
    const onDismiss = vi.fn();
    /* Three chapters × two factors each = 6 events. Expected: 3 chapter
       rows, header reads "3 chapters flagged", Regen-all fires 3×, but
       Dismiss-all still fires 6× (one per underlying factor-event). */
    const events: DriftEvent[] = [];
    for (const chapterId of [3, 4, 5]) {
      events.push(
        makeChapterEvent(chapterId, {
          id: `drift:book-A:${chapterId}:eliza:voice`,
          factor: 'voice',
          severity: 'severe',
          autoQueueable: true,
        }),
        makeChapterEvent(chapterId, {
          id: `drift:book-A:${chapterId}:eliza:warmth`,
          factor: 'warmth',
          severity: 'moderate',
          autoQueueable: false,
        }),
      );
    }
    render(
      <DriftReportModal
        groupsByBook={[group(events)]}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onDismiss={onDismiss}
      />,
    );
    /* Header: 3 unique chapters, not 6 events. */
    expect(screen.getByText(/3 chapters flagged/)).toBeInTheDocument();
    /* Expand the chapter strip and count rows: one per chapter. */
    fireEvent.click(screen.getByText(/Show 3 chapters/i));
    const rows = screen.getAllByTestId(/^drift-event-/);
    /* Each chapter's representative event is the top-severity one
       (voice → severe). That's the testid we'd see surface. */
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId('drift-event-drift:book-A:3:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-event-drift:book-A:4:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-event-drift:book-A:5:eliza:voice')).toBeInTheDocument();
    /* Regen-all → 3 chapter callbacks (was 6 pre-correction). */
    fireEvent.click(screen.getByTestId(/^drift-group-regen-all-/));
    expect(onRegenerateChapter).toHaveBeenCalledTimes(3);
    /* Dismiss-all → 6 event callbacks (every factor-event must be
       dismissed individually so the chapter doesn't reappear). */
    fireEvent.click(screen.getByTestId(/^drift-group-dismiss-all-/));
    expect(onDismiss).toHaveBeenCalledTimes(6);
  });

  it('single-row Dismiss on a multi-factor chapter dismisses every underlying factor-event', () => {
    const onDismiss = vi.fn();
    const events = [
      makeChapterEvent(3, {
        id: 'drift:book-A:3:eliza:voice',
        factor: 'voice',
        severity: 'severe',
      }),
      makeChapterEvent(3, {
        id: 'drift:book-A:3:eliza:warmth',
        factor: 'warmth',
        severity: 'moderate',
      }),
    ];
    render(
      <DriftReportModal
        groupsByBook={[group(events)]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    /* Single-chapter (after dedup) → inline action row, no expand. */
    fireEvent.click(screen.getByTestId('drift-dismiss-drift:book-A:3:eliza:voice'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledWith('drift:book-A:3:eliza:voice');
    expect(onDismiss).toHaveBeenCalledWith('drift:book-A:3:eliza:warmth');
  });
});

describe('DriftReportModal — per-character filter (pill-click entry)', () => {
  /* Two characters in the same book, each with drift on a different
     chapter. Filter on Eliza → only Eliza's card renders; Sten's card
     is dropped. The "Show all characters" affordance is the in-modal
     escape hatch so the user can drop the filter without re-opening. */
  const elizaEvent = makeEvent({ id: 'drift:book-A:1:eliza:voice', characterId: 'eliza', chapterId: 1 });
  const stenEvent = makeEvent({ id: 'drift:book-A:2:sten:voice', characterId: 'sten', chapterId: 2 });

  it('renders only the filtered character\'s card when filterCharacterId is set', () => {
    render(
      <DriftReportModal
        groupsByBook={[group([elizaEvent, stenEvent])]}
        filterCharacterId="eliza"
        onClearFilter={vi.fn()}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    /* Eliza card present, Sten card absent — the filter pruned the
       group before render reached DriftBookSection. */
    expect(screen.getByTestId('drift-event-drift:book-A:1:eliza:voice')).toBeInTheDocument();
    expect(screen.queryByTestId('drift-event-drift:book-A:2:sten:voice')).toBeNull();
    /* Header chapter count reflects the filtered view, not the
       cross-character total. */
    expect(screen.getByText(/1 chapter flagged/)).toBeInTheDocument();
    /* Banner names the filtered character + surfaces the escape
       hatch. Scope the name lookup to the banner so we don't false-
       positive against the card avatar / heading. */
    const banner = screen.getByTestId('drift-report-character-filter-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Eliza');
  });

  it('Show all characters button calls onClearFilter', () => {
    const onClearFilter = vi.fn();
    render(
      <DriftReportModal
        groupsByBook={[group([elizaEvent, stenEvent])]}
        filterCharacterId="eliza"
        onClearFilter={onClearFilter}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('drift-report-clear-character-filter'));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('falls back to the unfiltered descriptive paragraph when no filter is set', () => {
    render(
      <DriftReportModal
        groupsByBook={[group([elizaEvent, stenEvent])]}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('drift-report-character-filter-banner')).toBeNull();
    /* Both character cards are visible — no filter is applied. */
    expect(screen.getByTestId('drift-event-drift:book-A:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-event-drift:book-A:2:sten:voice')).toBeInTheDocument();
  });

  it('returns null (no empty modal) when the filter points at a character with zero events', () => {
    /* Race-condition guard: the dispatch order is filter-then-open,
       but a fast drift-poll could dismiss the matching events between
       the two. We render nothing rather than an empty-state modal so
       the user doesn\'t see a stub. */
    const { container } = render(
      <DriftReportModal
        groupsByBook={[group([elizaEvent, stenEvent])]}
        filterCharacterId="nonexistent-character"
        onClearFilter={vi.fn()}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
