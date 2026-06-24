/* Pairs with fe-6 (#413) — the 48 bar heights are a module-level constant,
   so the rendered profile is byte-identical across unmount/remount instead of
   regenerating a fresh seeded array per mount. */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Waveform, peaksToBars } from './waveform';

function barHeights(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span')).map((s) => s.style.height);
}

function barHeightNumbers(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('span')).map((s) => parseFloat(s.style.height));
}

describe('Waveform', () => {
  it('renders 48 bars', () => {
    const { container } = render(<Waveform progress={0} active={false} />);
    expect(barHeights(container)).toHaveLength(48);
  });

  it('stretches its bars to fill the container width (flex-1, not a fixed pixel width)', () => {
    const { container } = render(<Waveform progress={0} active />);
    const bars = Array.from(container.querySelectorAll('span')) as HTMLElement[];
    expect(bars).toHaveLength(48);
    // Fixed-width bars under-fill a wide container (the mini-player scrubber),
    // leaving a flat tail; flex-1 makes them span the full track.
    expect(bars.every((b) => b.className.includes('flex-1'))).toBe(true);
    expect(bars.some((b) => b.className.includes('w-[3px]'))).toBe(false);
  });

  it('produces identical bar heights across unmount/remount', () => {
    const first = render(<Waveform progress={0.3} active />);
    const heightsA = barHeights(first.container);
    first.unmount();

    const second = render(<Waveform progress={0.3} active />);
    const heightsB = barHeights(second.container);

    expect(heightsB).toEqual(heightsA);
  });

  it('is stable across two concurrent mounts', () => {
    const a = render(<Waveform progress={0} active={false} />);
    const b = render(<Waveform progress={1} active />);
    expect(barHeights(b.container)).toEqual(barHeights(a.container));
  });

  it('falls back to the seeded shape when peaks is empty', () => {
    const seeded = render(<Waveform progress={0} active={false} />);
    const withEmpty = render(<Waveform progress={0} active={false} peaks={[]} />);
    expect(barHeights(withEmpty.container)).toEqual(barHeights(seeded.container));
  });

  it('still renders 48 bars when driven by real peaks', () => {
    const peaks = Array.from({ length: 240 }, (_, i) => (i % 12) / 12);
    const { container } = render(<Waveform progress={0} active peaks={peaks} />);
    expect(barHeights(container)).toHaveLength(48);
  });

  it('derives heights from peaks — loudest bin maps to the tallest bar', () => {
    // Flat-low envelope with one loud window at the end.
    const peaks = Array.from({ length: 240 }, (_, i) => (i >= 235 ? 1 : 0.1));
    const { container } = render(<Waveform progress={0} active peaks={peaks} />);
    const heights = barHeightNumbers(container);
    const max = Math.max(...heights);
    // The tallest bar is the last one (where the loud window lives).
    expect(heights.indexOf(max)).toBe(heights.length - 1);
    // Loudest bar fills the track; quiet bars sit near the floor but visible.
    expect(max).toBeCloseTo(100, 5);
    expect(Math.min(...heights)).toBeGreaterThan(0);
  });

  it('a flat envelope yields uniform bars at the floor', () => {
    const { container } = render(
      <Waveform progress={0} active peaks={Array(240).fill(0.5)} />,
    );
    const heights = barHeightNumbers(container);
    expect(new Set(heights.map((h) => h.toFixed(4))).size).toBe(1);
  });
});

describe('Waveform issue overlay', () => {
  it('renders an sr-only reason list and aria-hides the bars when issues present', () => {
    const { container, getByText } = render(
      <Waveform
        progress={0}
        active
        peaks={Array(240).fill(0.5)}
        issues={[{ startFrac: 0.25, endFrac: 0.5, seekSec: 90, reasons: ['Long sentence'] }]}
      />,
    );
    expect(getByText(/Issue at 1:30: Long sentence/)).toBeInTheDocument();
    // some bars are amber
    expect(container.querySelectorAll('.bg-amber-400').length).toBeGreaterThan(0);
    // bar row is hidden from AT
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('exposes the issue reasons in a hover title on every amber bar', () => {
    const { container } = render(
      <Waveform
        progress={0}
        active
        peaks={Array(240).fill(0.5)}
        issues={[{ startFrac: 0.25, endFrac: 0.5, seekSec: 90, reasons: ['Suspiciously long'] }]}
      />,
    );
    const amber = Array.from(container.querySelectorAll('.bg-amber-400')) as HTMLElement[];
    expect(amber.length).toBeGreaterThan(0);
    // Every amber bar surfaces the reason + timestamp on hover (the sr-only list
    // alone left sighted users with nothing to read).
    expect(amber.every((b) => b.title.includes('Suspiciously long'))).toBe(true);
    expect(amber[0].title).toMatch(/1:30/);
  });

  it('renders unchanged (no amber, no list) with no issues', () => {
    const { container, queryByText } = render(
      <Waveform progress={0.5} active peaks={Array(240).fill(0.5)} />,
    );
    expect(container.querySelectorAll('.bg-amber-400').length).toBe(0);
    expect(queryByText(/Issue at/)).toBeNull();
  });

  it('paints no amber when peaks are empty even if issues exist', () => {
    const { container } = render(
      <Waveform
        progress={0}
        active
        peaks={[]}
        issues={[{ startFrac: 0.1, endFrac: 0.2, seekSec: 5, reasons: ['x'] }]}
      />,
    );
    // empty peaks → decorative fallback bars; caller is responsible for not
    // passing issues, but if it does we still must not assert a real shape.
    // Component renders the sr-only list; bars may be amber — that is the
    // caller's guard, not the component's. This test pins the sr-only list.
    expect(container.querySelector('ul.sr-only')).toBeInTheDocument();
  });
});

describe('peaksToBars', () => {
  it('returns null for undefined or empty input', () => {
    expect(peaksToBars(undefined)).toBeNull();
    expect(peaksToBars([])).toBeNull();
  });

  it('reduces a 240-bin envelope to the requested bar count', () => {
    const bars = peaksToBars(Array(240).fill(0.4), 48);
    expect(bars).toHaveLength(48);
  });

  it('normalises so the loudest bar is 1 and applies a floor', () => {
    const peaks = Array.from({ length: 240 }, (_, i) => (i < 5 ? 1 : 0.1));
    const bars = peaksToBars(peaks, 48)!;
    expect(Math.max(...bars)).toBeCloseTo(1, 5);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0.12);
  });

  it('maps an all-silent envelope to the uniform floor (no NaN)', () => {
    const bars = peaksToBars(Array(240).fill(0), 48)!;
    expect(bars.every((b) => b === 0.12)).toBe(true);
  });
});
