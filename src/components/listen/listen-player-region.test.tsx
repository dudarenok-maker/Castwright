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
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { ListenPlayerRegion } from './listen-player-region';
import { listenProgressSlice } from '../../store/listen-progress-slice';
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
