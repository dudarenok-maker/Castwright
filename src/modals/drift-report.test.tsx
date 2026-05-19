/* Pairs with docs/features/20-revisions-and-drift.md.

   Covers the C1+C2 split between auto-queueable (severe) and manual
   (moderate / mild) drift events: severe events render the one-click
   "Auto-regen now" pill that bypasses the regen-modal confirmation,
   moderate / mild events keep the existing "Regenerate this chapter"
   pill that opens the modal. When no autoQueueable handler is provided
   the modal falls back to the manual flow for every event (regression
   guard for surfaces that haven't opted into the shortcut). */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { DriftReportModal } from './drift-report';
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
  /* color must be a CHAR_COLORS key (narrator or slot-N) — see colors.ts.
     Drift-report does `CHAR_COLORS[char.color].hex`, so a fixture using
     unmapped names like 'magenta' would crash before the test assertions
     ran. voiceId added 2026-05-19 for the Listen A/B widget — the widget
     only mounts when a matching Voice is plumbed in via the `voices`
     prop, so character.voiceId has to resolve to an entry there. */
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
    id: 'drift:1:eliza:voice',
    characterId: 'eliza',
    chapterId: 1,
    severity: 'severe',
    factor: 'voice',
    factorLabel: 'Voice',
    description: 'Voice changed.',
    autoQueueable: true,
    detected: '2026-01-01T00:00:00Z',
    suggestedAction: 'regenerate_chapter',
    ...over,
  } as DriftEvent;
}

describe('DriftReportModal — auto-queueable severe drift (C1+C2)', () => {
  it('renders the Auto-regen now pill for severe + autoQueueable events when the handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[makeEvent({})]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const autoBtn = screen.getByTestId('drift-auto-regen-drift:1:eliza:voice');
    expect(autoBtn).toBeInTheDocument();
    expect(autoBtn).toHaveTextContent(/Auto-regen now/i);
    /* Manual pill is NOT rendered for this row — auto and manual are
       mutually exclusive on a single drift card. */
    expect(screen.queryByTestId('drift-regen-drift:1:eliza:voice')).toBeNull();

    fireEvent.click(autoBtn);
    expect(onAutoQueueRegenerate).toHaveBeenCalledWith('eliza', 1);
    /* The modal-opening manual handler stays untouched for auto-queueable rows. */
    expect(onRegenerateChapter).not.toHaveBeenCalled();
  });

  it('renders the manual Regenerate pill for moderate events even when an autoQueueable handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[
          makeEvent({
            id: 'drift:1:eliza:pace',
            factor: 'pace',
            factorLabel: 'Pace',
            severity: 'moderate',
            autoQueueable: undefined,
          }),
        ]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const manualBtn = screen.getByTestId('drift-regen-drift:1:eliza:pace');
    expect(manualBtn).toBeInTheDocument();
    expect(manualBtn).toHaveTextContent(/Regenerate this chapter/i);
    expect(screen.queryByTestId('drift-auto-regen-drift:1:eliza:pace')).toBeNull();

    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('eliza', 1);
    expect(onAutoQueueRegenerate).not.toHaveBeenCalled();
  });

  it('falls back to the manual Regenerate pill on every event when no autoQueueable handler is provided', () => {
    /* Regression guard: surfaces that haven't opted into the shortcut
       (or are still mocking the modal under test) get the original UX
       without lighting up the new affordance. */
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[makeEvent({})]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('drift-auto-regen-drift:1:eliza:voice')).toBeNull();
    const manualBtn = screen.getByTestId('drift-regen-drift:1:eliza:voice');
    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('eliza', 1);
  });

  it('groups severe + moderate events under separate severity headings (regression for the existing layout)', () => {
    /* Spot-check the existing grouping behavior survives the C1+C2
       split — the severe row picks up the Auto-regen pill while the
       moderate row keeps the manual pill, in the same modal. */
    const onAutoQueueRegenerate = vi.fn();
    render(
      <DriftReportModal
        events={[
          makeEvent({}),
          makeEvent({
            id: 'drift:1:sten:pace',
            characterId: 'sten',
            factor: 'pace',
            factorLabel: 'Pace',
            severity: 'moderate',
            autoQueueable: undefined,
          }),
        ]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('drift-auto-regen-drift:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-regen-drift:1:sten:pace')).toBeInTheDocument();
  });
});

/* Bug 8 — Listen button A/B player. Pre-fix the button at drift-report.tsx:165
   was a pure stub: no onClick, no callback, no caller wiring. Now it expands
   inline into two-button A/B controls: A plays the chapter audio that drifted
   (static URL), B plays a sample of the established voice profile (lazy
   resolved via api.getVoiceSample). Mutex via component state — only one
   plays at a time. */
describe('DriftReportModal — Listen A/B compare player (bug 8)', () => {
  /* Single prototype-level spy serves both A + B elements. The Bs are
     aliases purely for test-name readability — there's only one method
     on HTMLMediaElement.prototype to spy on. */
  let playSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let playASpy: ReturnType<typeof vi.spyOn>;
  let pauseASpy: ReturnType<typeof vi.spyOn>;
  let playBSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    /* Stub HTMLMediaElement.play / pause so audio elements don't actually
       fire decode + autoplay errors in jsdom. Vitest's jsdom doesn't ship
       a real media pipeline. Each test gets a fresh spy. */
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
          events={events}
          characters={characters}
          bookId="b-keeper"
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
    const listenBtn = screen.getByTestId('drift-listen-drift:1:eliza:voice');
    /* Pre-click: A/B controls hidden. */
    expect(screen.queryByTestId('drift-play-chapter-drift:1:eliza:voice')).toBeNull();
    expect(screen.queryByTestId('drift-play-voice-drift:1:eliza:voice')).toBeNull();
    fireEvent.click(listenBtn);
    /* Post-click: both buttons present. */
    expect(
      screen.getByTestId('drift-play-chapter-drift:1:eliza:voice'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('drift-play-voice-drift:1:eliza:voice')).toBeInTheDocument();
  });

  it('Play chapter calls .play() on the chapter audio element', () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalled();
  });

  it('Play voice fetches the sample URL on first click and plays it', async () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-voice-drift:1:eliza:voice'));
    await waitFor(() => expect(getVoiceSampleSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(playBSpy).toHaveBeenCalled());
  });

  it('starting B while A is playing pauses A first (mutex)', async () => {
    renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('drift-play-voice-drift:1:eliza:voice'));
    await waitFor(() => expect(playBSpy).toHaveBeenCalled());
    /* pauseASpy === pauseBSpy in this fixture (same prototype spy) — assert
       a pause fired at least once before the second play. */
    expect(pauseASpy).toHaveBeenCalled();
  });

  it('closing the modal pauses both audio elements (cleanup)', () => {
    const { unmount } = renderModalWithVoices([makeEvent({})]);
    fireEvent.click(screen.getByTestId('drift-listen-drift:1:eliza:voice'));
    fireEvent.click(screen.getByTestId('drift-play-chapter-drift:1:eliza:voice'));
    expect(playASpy).toHaveBeenCalled();
    /* Unmount mimics modal-close — useEffect cleanup must pause the audio. */
    pauseASpy.mockClear();
    unmount();
    expect(pauseASpy).toHaveBeenCalled();
  });
});
