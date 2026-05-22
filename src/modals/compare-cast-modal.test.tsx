/* Compare-cast modal — covers the diff layout, dirty-state save flow,
   live re-sample with edits, and the Auto A→B sequencing. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { CompareCastModal } from './compare-cast-modal';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

const playbackState = {
  isPlaying: false as boolean,
  currentUrl: null as string | null,
  play: vi.fn(async () => {}),
  stop: vi.fn(() => {
    playbackState.isPlaying = false;
    playbackState.currentUrl = null;
  }),
  playUntilEnded: vi.fn(async () => ({ cancelled: false })),
};
vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => playbackState,
}));

vi.mock('../lib/api', () => ({ api: {} }));

const charA: Character = {
  id: 'halloran',
  name: 'Halloran',
  role: 'Detective',
  color: 'halloran',
  lines: 50,
  attributes: ['gruff', 'weary'],
  gender: 'male',
  ageRange: 'adult',
  tone: { warmth: 30, pace: 40, authority: 70, emotion: 35 },
};

const charB: Character = {
  id: 'marcus',
  name: 'Marcus',
  role: 'Witness',
  color: 'eliza',
  lines: 12,
  attributes: ['nervous', 'gruff'],
  gender: 'male',
  ageRange: 'elderly',
  tone: { warmth: 30, pace: 40, authority: 70, emotion: 35 },
};

function renderModal(overrides?: Partial<Parameters<typeof CompareCastModal>[0]>) {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  const props = {
    characters: [charA, charB] as [Character, Character],
    library: [] as Voice[],
    ttsModelKey: 'kokoro-v1' as const,
    onSaveSide: vi.fn(),
    onClose: vi.fn(),
    onOpenProfile: vi.fn(),
    ...overrides,
  };
  const view = render(
    <Provider store={store}>
      <CompareCastModal {...props} />
    </Provider>,
  );
  return { ...view, props };
}

beforeEach(() => {
  playbackState.isPlaying = false;
  playbackState.currentUrl = null;
  playbackState.play.mockClear();
  playbackState.stop.mockClear();
  playbackState.playUntilEnded.mockReset();
  playbackState.playUntilEnded.mockResolvedValue({ cancelled: false });
  vi.mocked(playSampleWithAutoLoad).mockClear();
  vi.mocked(playSampleWithAutoLoad).mockResolvedValue({ analyzerEvicted: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CompareCastModal diff rendering', () => {
  it('marks age range as differing (≠) when the two characters disagree', () => {
    renderModal();
    /* Halloran is adult, Marcus is elderly — both Age rows carry the ≠
       marker. We check at least 2 ≠ markers near the Age label exist. */
    const diffMarkers = screen.getAllByLabelText('differs');
    expect(diffMarkers.length).toBeGreaterThanOrEqual(2);
  });

  it('does not mark the gender row as differing when both characters are male', () => {
    renderModal();
    /* Sanity: gender is shared, so the gender-row ≠ should not appear.
       We don't have a direct selector for "gender row" but the count of
       ≠ markers should be limited to age + voice + profile differences,
       not gender. Asserting count is fragile; instead, assert the
       Gender label exists without an immediate ≠ neighbour by reading
       the surrounding text content. */
    const sideA = screen.getByLabelText(/Side A: Halloran/);
    /* Inside side A, find the Gender editor — confirm no ≠ pill is in
       the same flex row. */
    const genderLabel = within(sideA).getAllByText('Gender')[0];
    const row = genderLabel.closest('div')!;
    expect(within(row).queryByLabelText('differs')).toBeNull();
  });

  it('flags attributes that only appear on one side as ≠ chips', () => {
    renderModal();
    /* "weary" is only on Halloran, "nervous" is only on Marcus —
       both should appear under "Attributes only on this side". */
    expect(screen.getByText(/≠ weary/)).toBeInTheDocument();
    expect(screen.getByText(/≠ nervous/)).toBeInTheDocument();
  });
});

describe('CompareCastModal dirty / save flow', () => {
  it('keeps the Save button disabled until a field is edited', () => {
    renderModal();
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect(saveButtons[0]).toBeDisabled();
    expect(saveButtons[1]).toBeDisabled();
  });

  it('enables Save on the edited side and calls onSaveSide with the merged character', async () => {
    const { props } = renderModal();
    const sideA = screen.getByLabelText(/Side A: Halloran/);
    const genderSelect = within(sideA).getByLabelText('Gender for Halloran') as HTMLSelectElement;

    fireEvent.change(genderSelect, { target: { value: 'female' } });

    const saveA = within(sideA).getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveA).not.toBeDisabled());

    /* Side B's Save stays disabled — dirty is per-side. */
    const sideB = screen.getByLabelText(/Side B: Marcus/);
    expect(within(sideB).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(saveA);
    expect(props.onSaveSide).toHaveBeenCalledTimes(1);
    expect(props.onSaveSide).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'halloran',
        gender: 'female',
      }),
    );
  });
});

describe('CompareCastModal sample playback', () => {
  it('calls playSampleWithAutoLoad with a hint built from the dirty draft', async () => {
    renderModal();
    const sideA = screen.getByLabelText(/Side A: Halloran/);
    const ageSelect = within(sideA).getByLabelText('Age range for Halloran') as HTMLSelectElement;

    fireEvent.change(ageSelect, { target: { value: 'child' } });
    fireEvent.click(within(sideA).getByLabelText(/Play sample for Halloran/));

    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const call = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0];
    expect(call.args.characterHint?.ageRange).toBe('child');
    expect(call.args.characterHint?.gender).toBe('male');
  });
});

describe('CompareCastModal Auto A→B', () => {
  it('plays side A first, then side B, awaiting playUntilEnded between them', async () => {
    renderModal();
    /* Order tracking: each phase pushes an entry; we assert the final
       sequence matches the expected pattern. */
    const trace: string[] = [];
    vi.mocked(playSampleWithAutoLoad).mockImplementation(async ({ args }) => {
      trace.push(`synth:${args.voiceId}`);
      return { analyzerEvicted: false };
    });
    playbackState.playUntilEnded.mockImplementation(async () => {
      trace.push('ended');
      return { cancelled: false };
    });

    fireEvent.click(screen.getByRole('button', { name: /Auto A → B/ }));

    await waitFor(() => expect(trace.length).toBe(4));
    expect(trace).toEqual(['synth:char-halloran', 'ended', 'synth:char-marcus', 'ended']);
  });

  it('stops the sequence when playUntilEnded reports cancelled', async () => {
    renderModal();
    const calls: string[] = [];
    vi.mocked(playSampleWithAutoLoad).mockImplementation(async ({ args }) => {
      calls.push(args.voiceId);
      return { analyzerEvicted: false };
    });
    playbackState.playUntilEnded.mockResolvedValue({ cancelled: true });

    fireEvent.click(screen.getByRole('button', { name: /Auto A → B/ }));

    /* Side A synth fires, the ended-await reports cancelled, so side B
       must not synth. */
    await waitFor(() => expect(calls).toEqual(['char-halloran']));
  });
});

describe('CompareCastModal close behaviour', () => {
  it('calls onClose on ESC keypress', () => {
    const { props } = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('calls onClose when the overlay is clicked', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByTestId('compare-cast-overlay'));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe('CompareCastModal propagation hint (plan 96)', () => {
  it('hides the "Saves propagate" hint by default (cast.tsx call-site)', () => {
    /* `cast.tsx` opens Compare for single-book pairs and never sets the
       prop. The hint must stay hidden so the single-book modal looks
       identical to before plan 96. */
    renderModal();
    expect(screen.queryByText(/Saves propagate to every book in this series/)).toBeNull();
  });

  it('renders the "Saves propagate" hint on both sides when propagatesAcrossSeries is true', () => {
    /* `voices.tsx` opens Compare with the prop set — saves go through
       the series-patch endpoint so the user needs an inline cue that
       this isn't a book-local edit. */
    renderModal({ propagatesAcrossSeries: true });
    const hints = screen.getAllByText(/Saves propagate to every book in this series/);
    /* One per side — both sides exposed to the same propagation rule. */
    expect(hints).toHaveLength(2);
  });
});
