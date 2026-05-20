/* Plan 77 — LoudnessReport component coverage. Pins:

   - Summary copy reflects the on-target / measured / target values.
   - Sparkline renders one column per chapter, with bucket attributes
     so visual regression has stable test hooks.
   - Single-pass measurements degrade to neutral — they're NOT
     post-filter measurements, so rendering them as ground truth
     would mislead the user. This is the critical gate.
   - Empty state appears when no chapter carries lufs data at all.
   - Expandable table toggles open/closed.
   - Excluded chapters are filtered out (parity with listen view's
     `listenable`). */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LoudnessReport, classifyDrift } from './loudness-report';
import type { Chapter, ChapterLoudness } from '../lib/types';

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

describe('classifyDrift — bucket thresholds', () => {
  it('classifies ≤ 2 LU drift as on-target', () => {
    expect(classifyDrift(lufs(0))).toBe('on-target');
    expect(classifyDrift(lufs(1.9))).toBe('on-target');
    expect(classifyDrift(lufs(-2))).toBe('on-target');
  });
  it('classifies 2-4 LU drift as slight', () => {
    expect(classifyDrift(lufs(2.5))).toBe('slight');
    expect(classifyDrift(lufs(-3.9))).toBe('slight');
    expect(classifyDrift(lufs(4))).toBe('slight');
  });
  it('classifies > 4 LU drift as off-target', () => {
    expect(classifyDrift(lufs(4.5))).toBe('off-target');
    expect(classifyDrift(lufs(-7))).toBe('off-target');
  });
  it('classifies null / undefined / missing payload as no-data', () => {
    expect(classifyDrift(null)).toBe('no-data');
    expect(classifyDrift(undefined)).toBe('no-data');
  });
  it('classifies single-pass payloads as no-data — the critical gate', () => {
    /* twoPass: false means the value is the nominal target, NOT a
       post-filter measurement. Rendering it as ground truth would
       mislead the user. Must degrade to neutral. */
    expect(classifyDrift(lufs(0, { twoPass: false }))).toBe('no-data');
    expect(classifyDrift(lufs(5, { twoPass: false }))).toBe('no-data');
  });
});

describe('LoudnessReport — summary + sparkline', () => {
  it('renders the on-target / measured count in the summary line when chapters are within target', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }),
      makeChapter(2, { lufs: lufs(-0.5) }),
      makeChapter(3, { lufs: lufs(0.3) }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    const summary = screen.getByTestId('loudness-report-summary');
    expect(summary.textContent).toContain('3 of 3');
    expect(summary.textContent).toContain('±2 LU');
  });

  it('shows mixed bucket counts when drift is varied', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }), // on-target
      makeChapter(2, { lufs: lufs(2.6) }), // slight
      makeChapter(3, { lufs: lufs(-1.2) }), // on-target
      makeChapter(4, { lufs: lufs(5.2) }), // off-target
      makeChapter(5, { lufs: lufs(-3.5) }), // slight
    ];
    render(<LoudnessReport chapters={chapters} />);
    /* The bucket pills use the existing Pill primitive — match copy. */
    expect(screen.getByText(/2 on target/)).toBeInTheDocument();
    expect(screen.getByText(/2 slight drift/)).toBeInTheDocument();
    expect(screen.getByText(/1 off target/)).toBeInTheDocument();
  });

  it('renders one sparkline column per chapter, tagged with its bucket', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }),
      makeChapter(2, { lufs: lufs(2.6) }),
      makeChapter(3, { lufs: lufs(5.2) }),
      makeChapter(4, { lufs: null }), // no-data
    ];
    render(<LoudnessReport chapters={chapters} />);
    expect(screen.getByTestId('loudness-report-sparkline')).toBeInTheDocument();
    expect(screen.getByTestId('loudness-report-spark-1').getAttribute('data-bucket')).toBe(
      'on-target',
    );
    expect(screen.getByTestId('loudness-report-spark-2').getAttribute('data-bucket')).toBe(
      'slight',
    );
    expect(screen.getByTestId('loudness-report-spark-3').getAttribute('data-bucket')).toBe(
      'off-target',
    );
    expect(screen.getByTestId('loudness-report-spark-4').getAttribute('data-bucket')).toBe(
      'no-data',
    );
  });

  it('counts only listenable chapters — excluded chapters are filtered out', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }),
      makeChapter(2, { lufs: lufs(0.1), excluded: true }), // front-matter
      makeChapter(3, { lufs: lufs(0.1) }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    /* The excluded chapter contributes neither to the summary count nor
       to the sparkline. */
    expect(screen.getByTestId('loudness-report-summary').textContent).toContain('2 of 2');
    expect(screen.queryByTestId('loudness-report-spark-2')).toBeNull();
  });
});

describe('LoudnessReport — single-pass gate (CRITICAL)', () => {
  it('renders single-pass measurements as no-data, NOT as ground truth', () => {
    /* This is the critical contract from plan 71: twoPass: false means
       the `i` value is the nominal TARGET, not a real measurement of the
       output. Rendering it as on-target would silently lie about a
       chapter that may be wildly off (the encoder just didn't measure). */
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0, { twoPass: false }) }),
      makeChapter(2, { lufs: lufs(0, { twoPass: false }) }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    /* All single-pass — same as no data: the empty state renders. */
    expect(screen.getByTestId('loudness-report-empty')).toBeInTheDocument();
  });

  it('mixed two-pass + single-pass: single-pass rows render as neutral', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }), // two-pass on-target
      makeChapter(2, { lufs: lufs(0, { twoPass: false }) }), // neutral
    ];
    render(<LoudnessReport chapters={chapters} />);
    expect(screen.getByTestId('loudness-report-summary').textContent).toContain('1 of 1');
    /* Open the table to inspect rows. */
    fireEvent.click(screen.getByTestId('loudness-report-toggle'));
    const row1 = screen.getByTestId('loudness-report-row-1');
    const row2 = screen.getByTestId('loudness-report-row-2');
    expect(row1.getAttribute('data-bucket')).toBe('on-target');
    expect(row2.getAttribute('data-bucket')).toBe('no-data');
    /* The single-pass row's measured / drift cells show em-dashes — the
       value isn't a real measurement so we don't print it. */
    expect(within(row2).getByText('No measurement')).toBeInTheDocument();
  });
});

describe('LoudnessReport — empty state', () => {
  it('renders empty-state copy when no chapter carries lufs data', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: null }),
      makeChapter(2, { lufs: undefined }),
      makeChapter(3, { lufs: null }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    expect(screen.getByTestId('loudness-report-empty')).toBeInTheDocument();
    expect(screen.getByTestId('loudness-report-empty').textContent).toMatch(
      /AUDIO_LOUDNORM_ENABLED/,
    );
    /* No sparkline or summary line in the empty case. */
    expect(screen.queryByTestId('loudness-report-sparkline')).toBeNull();
    expect(screen.queryByTestId('loudness-report-summary')).toBeNull();
  });

  it('renders empty-state copy when the chapter list is empty', () => {
    render(<LoudnessReport chapters={[]} />);
    expect(screen.getByTestId('loudness-report-empty')).toBeInTheDocument();
  });
});

describe('LoudnessReport — expandable table', () => {
  it('toggles the per-chapter table open and closed', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.1) }),
      makeChapter(2, { lufs: lufs(2.6) }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    /* Table is collapsed by default. */
    expect(screen.queryByTestId('loudness-report-table')).toBeNull();
    fireEvent.click(screen.getByTestId('loudness-report-toggle'));
    expect(screen.getByTestId('loudness-report-table')).toBeInTheDocument();
    /* Both rows present. */
    expect(screen.getByTestId('loudness-report-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('loudness-report-row-2')).toBeInTheDocument();
    /* Toggle closes. */
    fireEvent.click(screen.getByTestId('loudness-report-toggle'));
    expect(screen.queryByTestId('loudness-report-table')).toBeNull();
  });

  it('per-row badge reflects each chapter\'s bucket', () => {
    const chapters: Chapter[] = [
      makeChapter(1, { lufs: lufs(0.5) }),
      makeChapter(2, { lufs: lufs(3.1) }),
      makeChapter(3, { lufs: lufs(5.5) }),
      makeChapter(4, { lufs: null }),
    ];
    render(<LoudnessReport chapters={chapters} />);
    fireEvent.click(screen.getByTestId('loudness-report-toggle'));
    expect(screen.getByTestId('loudness-report-row-1').getAttribute('data-bucket')).toBe(
      'on-target',
    );
    expect(screen.getByTestId('loudness-report-row-2').getAttribute('data-bucket')).toBe('slight');
    expect(screen.getByTestId('loudness-report-row-3').getAttribute('data-bucket')).toBe(
      'off-target',
    );
    expect(screen.getByTestId('loudness-report-row-4').getAttribute('data-bucket')).toBe(
      'no-data',
    );
  });
});
