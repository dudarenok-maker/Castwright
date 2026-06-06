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
