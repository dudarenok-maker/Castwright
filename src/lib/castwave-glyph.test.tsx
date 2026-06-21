// src/lib/castwave-glyph.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CastwaveGlyph } from './castwave-glyph';

describe('CastwaveGlyph', () => {
  it('renders an svg with the brand waveform and inherits colour', () => {
    const { container } = render(<CastwaveGlyph className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('class')).toContain('x');
    expect(svg.querySelectorAll('rect, path').length).toBeGreaterThan(0);
  });
});
