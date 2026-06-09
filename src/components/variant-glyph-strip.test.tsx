import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantGlyphStrip } from './variant-glyph-strip';

describe('VariantGlyphStrip', () => {
  it('renders one glyph per in-use emotion, marking designed vs needed', () => {
    render(<VariantGlyphStrip usedEmotions={new Set(['angry', 'excited'])} designedEmotions={new Set(['angry'])} />);
    expect(screen.getByTestId('variant-glyph-angry')).toHaveAttribute('data-state', 'designed');
    expect(screen.getByTestId('variant-glyph-excited')).toHaveAttribute('data-state', 'needed');
  });
  it('shows a complete state when every in-use emotion is designed', () => {
    render(<VariantGlyphStrip usedEmotions={new Set(['angry'])} designedEmotions={new Set(['angry'])} />);
    expect(screen.getByTestId('variants-complete')).toBeInTheDocument();
  });
  it('renders the no-tags hint when there are no in-use emotions', () => {
    render(<VariantGlyphStrip usedEmotions={new Set()} designedEmotions={new Set()} />);
    expect(screen.getByTestId('variants-no-tags')).toBeInTheDocument();
  });
  it('tooltip names the emotion + state', () => {
    render(<VariantGlyphStrip usedEmotions={new Set(['sad'])} designedEmotions={new Set()} />);
    expect(screen.getByTestId('variant-glyph-sad')).toHaveAttribute('title', 'Sad — needs a variant');
  });
});
