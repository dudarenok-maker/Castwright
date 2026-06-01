/* Plan 77 — ListenPlayerRegion per-chapter loudness badge coverage.

   Pins the colour-coded drift pill that renders inside each chapter
   row, gated on `lufs.twoPass === true`. The full report card is
   covered separately in `loudness-report.test.tsx`; this spec focuses
   on the per-row affordance.

   Critical contract: chapters with `twoPass: false` MUST render NO
   badge — single-pass measurements are nominal target values, not
   post-filter measurements, so rendering them as ground truth would
   mislead the user. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { ListenPlayerRegion } from './listen-player-region';
import { listenProgressSlice, listenProgressActions } from '../../store/listen-progress-slice';
import type { Chapter, ChapterLoudness } from '../../lib/types';

function makeStore() {
  return configureStore({
    reducer: { listenProgress: listenProgressSlice.reducer },
  });
}

function lufs(deltaFromTarget: number, opts: Partial<ChapterLoudness> = {}): ChapterLoudness {
  return {
    i: -16 + deltaFromTarget,
    lra: 8,
    tp: -2.1,
    target: -16,
    twoPass: true,
    measuredAt: '2026-05-20T12:00:00.000Z',
    ...opts,
  };
}

function makeChapter(id: number, overrides: Partial<Chapter> = {}): Chapter {
  return {
    id,
    title: `Chapter ${id}`,
    duration: '10:00',
    state: 'done',
    progress: 1,
    characters: {},
    ...overrides,
  } as Chapter;
}

function renderRegion(chapters: Chapter[]) {
  return render(
    <Provider store={makeStore()}>
      <ListenPlayerRegion
        bookId="test-book"
        chapters={chapters}
        listenable={chapters.filter((c) => !c.excluded)}
        characters={[]}
        currentTrack={null}
        onPlayChapter={vi.fn()}
        onRegenerate={vi.fn()}
        onSeekMarker={vi.fn()}
        onDeleteMarker={vi.fn()}
      />
    </Provider>,
  );
}

describe('ListenPlayerRegion — per-chapter LUFS badge (plan 77)', () => {
  it('renders a green badge for chapters within ±2 LU of target', () => {
    renderRegion([makeChapter(1, { lufs: lufs(0.4) })]);
    const badge = screen.getByTestId('chapter-row-1-lufs-badge');
    expect(badge.getAttribute('data-bucket')).toBe('on-target');
    expect(badge.textContent).toMatch(/LUFS/);
  });

  it('renders an amber badge for chapters 2–4 LU off target', () => {
    renderRegion([makeChapter(1, { lufs: lufs(3.1) })]);
    const badge = screen.getByTestId('chapter-row-1-lufs-badge');
    expect(badge.getAttribute('data-bucket')).toBe('slight');
  });

  it('renders a red badge for chapters > 4 LU off target', () => {
    renderRegion([makeChapter(1, { lufs: lufs(5.5) })]);
    const badge = screen.getByTestId('chapter-row-1-lufs-badge');
    expect(badge.getAttribute('data-bucket')).toBe('off-target');
  });

  it('does NOT render a badge when the chapter has no lufs data (legacy / disabled)', () => {
    /* The row must still render — only the badge is absent. */
    renderRegion([makeChapter(1, { lufs: null })]);
    expect(screen.getByTestId('chapter-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('chapter-row-1-lufs-badge')).toBeNull();
  });

  it('does NOT render a badge when the chapter has undefined lufs (older server / not fetched)', () => {
    renderRegion([makeChapter(1, { lufs: undefined })]);
    expect(screen.getByTestId('chapter-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('chapter-row-1-lufs-badge')).toBeNull();
  });

  it('does NOT render a badge when twoPass is false (single-pass gate — CRITICAL)', () => {
    /* This is the critical contract from plan 71: twoPass: false means
       `i` is the nominal target, not a real measurement. Rendering it
       coloured would silently lie about the chapter's actual loudness.
       The badge MUST be suppressed. */
    renderRegion([makeChapter(1, { lufs: lufs(0, { twoPass: false }) })]);
    expect(screen.getByTestId('chapter-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('chapter-row-1-lufs-badge')).toBeNull();
  });

  it('badge tooltip surfaces target + LRA + true peak for the curious', () => {
    renderRegion([
      makeChapter(1, {
        lufs: lufs(-1, { lra: 9.4, tp: -1.8 }),
      }),
    ]);
    const badge = screen.getByTestId('chapter-row-1-lufs-badge');
    const tooltip = badge.getAttribute('title') ?? '';
    expect(tooltip).toMatch(/On target/);
    expect(tooltip).toMatch(/target -16 LUFS/);
    expect(tooltip).toMatch(/LRA 9\.4 LU/);
    expect(tooltip).toMatch(/true peak -1\.8 dBTP/);
  });

  it('badge value reflects measured integrated loudness to one decimal', () => {
    renderRegion([makeChapter(1, { lufs: lufs(-0.7) })]); // i = -16.7
    const badge = screen.getByTestId('chapter-row-1-lufs-badge');
    /* Minus-sign is U+2212 in our formatter (numeric typography). */
    expect(badge.textContent).toContain('−16.7');
  });
});

describe('ListenPlayerRegion — LoudnessReport card', () => {
  it('mounts the report card alongside the chapter list', () => {
    renderRegion([makeChapter(1, { lufs: lufs(0) }), makeChapter(2, { lufs: lufs(2.5) })]);
    expect(screen.getByTestId('loudness-report')).toBeInTheDocument();
  });
});

/* Plan 93 — chapter-list virtualisation threshold. The list has its
   own internal scroll container (max-h-[560px]) — `useVirtualizer`
   with `getScrollElement` is the right shape (not the window
   virtualizer manuscript uses). Below 40 chapters the flat-render
   path stays for short books; above it, the windowed render takes
   over. */
describe('ListenPlayerRegion — chapter-list virtualisation threshold (plan 93)', () => {
  function manyChapters(n: number): Chapter[] {
    return Array.from({ length: n }, (_, i) => makeChapter(i + 1));
  }

  it('renders the flat chapter list below the 40-row threshold', () => {
    renderRegion(manyChapters(20));
    expect(screen.queryByTestId('listen-chapters-virtual-container')).toBeNull();
    /* Flat path still mounts row testids. */
    expect(screen.getByText('Chapter 1')).toBeInTheDocument();
  });

  it('switches to the virtualised container at or above the threshold', () => {
    renderRegion(manyChapters(60));
    expect(screen.getByTestId('listen-chapters-virtual-container')).toBeInTheDocument();
  });
});

/* Plan 125 — the playing row mirrors the mini-player's real playhead
   (elapsed + total, matched to the second) instead of a decorative
   animation, and the "Resume at" pill is suppressed on the actively-
   playing chapter while still showing on other bookmarked rows. */
describe('ListenPlayerRegion — live row sync + pill-hidden-while-playing (plan 125)', () => {
  function renderPlaying(
    store: ReturnType<typeof makeStore>,
    chapters: Chapter[],
    currentTrack: number | null,
  ) {
    return render(
      <Provider store={store}>
        <ListenPlayerRegion
          bookId="test-book"
          chapters={chapters}
          listenable={chapters.filter((c) => !c.excluded)}
          characters={[]}
          currentTrack={currentTrack}
          onPlayChapter={vi.fn()}
          onRegenerate={vi.fn()}
          onSeekMarker={vi.fn()}
          onDeleteMarker={vi.fn()}
        />
      </Provider>,
    );
  }

  it('the playing row shows live elapsed / total matching the player to the second', () => {
    const store = makeStore();
    /* currentSec 44.4 → formatTime "0:44"; durationSec 44.8 → "0:44" (PCM-
       exact total the player displays, distinct from the "00:45" metadata). */
    store.dispatch(
      listenProgressActions.setLivePlayback({
        bookId: 'test-book',
        chapterId: 1,
        currentSec: 44.4,
        durationSec: 44.8,
      }),
    );
    renderPlaying(store, [makeChapter(1, { duration: '00:45' })], 1);
    expect(screen.getByTestId('chapter-row-1')).toHaveTextContent('0:44 / 0:44');
  });

  it('hides the Resume pill on the actively-playing chapter', () => {
    const store = makeStore();
    store.dispatch(
      listenProgressActions.hydrate({
        bookId: 'test-book',
        progress: { chapterId: 1, currentSec: 30, updatedAt: '2026-05-28T00:00:00.000Z' },
      }),
    );
    store.dispatch(
      listenProgressActions.setLivePlayback({
        bookId: 'test-book',
        chapterId: 1,
        currentSec: 44,
        durationSec: 45,
      }),
    );
    renderPlaying(store, [makeChapter(1)], 1);
    const row = screen.getByTestId('chapter-row-1');
    expect(within(row).queryByText(/Resume at/i)).toBeNull();
  });

  it('still shows the Resume pill on a bookmarked row that is NOT playing', () => {
    const store = makeStore();
    store.dispatch(
      listenProgressActions.hydrate({
        bookId: 'test-book',
        progress: { chapterId: 2, currentSec: 30, updatedAt: '2026-05-28T00:00:00.000Z' },
      }),
    );
    /* Chapter 1 is playing; chapter 2 is bookmarked + idle → pill stays. */
    renderPlaying(store, [makeChapter(1), makeChapter(2)], 1);
    const row2 = screen.getByTestId('chapter-row-2');
    expect(within(row2).getByText(/Resume at/i)).toBeInTheDocument();
  });
});

/* Ungenerated chapters have no audio to play or share — only a
   placeholder "0:00" duration. The row stays visible but reads as
   inert: Play + Share disabled, and a state-aware label
   (Queued / Generating… / Failed) replaces the misleading "0:00".
   Regenerate stays active (it can kick off / retry generation). */
describe('ListenPlayerRegion — ungenerated-chapter affordances', () => {
  it('disables Play + Share and shows "Queued" instead of 0:00 for a queued chapter', () => {
    renderRegion([makeChapter(1, { state: 'queued', duration: '0:00' })]);
    const row = screen.getByTestId('chapter-row-1');
    expect(screen.getByLabelText('Chapter 1 not yet generated')).toBeDisabled();
    expect(screen.getByTestId('chapter-row-1-share-clip')).toBeDisabled();
    expect(within(row).getByText('Queued')).toBeInTheDocument();
    expect(within(row).queryByText('0:00')).toBeNull();
  });

  it('shows "Generating…" for an in_progress chapter', () => {
    renderRegion([makeChapter(1, { state: 'in_progress', duration: '0:00' })]);
    const row = screen.getByTestId('chapter-row-1');
    expect(within(row).getByText('Generating…')).toBeInTheDocument();
    expect(screen.getByLabelText('Chapter 1 not yet generated')).toBeDisabled();
    expect(screen.getByTestId('chapter-row-1-share-clip')).toBeDisabled();
  });

  it('shows "Failed" for a failed chapter', () => {
    renderRegion([makeChapter(1, { state: 'failed', duration: '0:00' })]);
    const row = screen.getByTestId('chapter-row-1');
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Chapter 1 not yet generated')).toBeDisabled();
    expect(screen.getByTestId('chapter-row-1-share-clip')).toBeDisabled();
  });

  it('keeps Regenerate active on a non-done chapter (it can start generation)', () => {
    const onRegenerate = vi.fn();
    render(
      <Provider store={makeStore()}>
        <ListenPlayerRegion
          bookId="test-book"
          chapters={[makeChapter(1, { state: 'queued', duration: '0:00' })]}
          listenable={[makeChapter(1, { state: 'queued', duration: '0:00' })]}
          characters={[]}
          currentTrack={null}
          onPlayChapter={vi.fn()}
          onRegenerate={onRegenerate}
          onSeekMarker={vi.fn()}
          onDeleteMarker={vi.fn()}
        />
      </Provider>,
    );
    const regen = screen.getByLabelText('Regenerate chapter 1');
    expect(regen).not.toBeDisabled();
  });

  it('leaves Play + Share active and shows the real duration for a done chapter', () => {
    renderRegion([makeChapter(1, { state: 'done', duration: '10:00' })]);
    const row = screen.getByTestId('chapter-row-1');
    expect(screen.getByLabelText('Play chapter 1')).not.toBeDisabled();
    expect(screen.getByTestId('chapter-row-1-share-clip')).not.toBeDisabled();
    expect(within(row).getByText('10:00')).toBeInTheDocument();
  });
});
