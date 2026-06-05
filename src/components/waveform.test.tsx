/* Pairs with fe-6 (#413) — the 48 bar heights are a module-level constant,
   so the rendered profile is byte-identical across unmount/remount instead of
   regenerating a fresh seeded array per mount. */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Waveform } from './waveform';

function barHeights(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span')).map((s) => s.style.height);
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
});
