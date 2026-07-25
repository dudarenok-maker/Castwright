/* fs-38 Wave 1, Task 16 — VoiceProvenanceBadge. Pins the three derivation
   branches off a bare `overrideTtsVoices[engine]` slot: libraryUuid wins
   ("My voice"), else provenance:'designed' ("Designed"), else "Catalogue"
   (no slot, or a plain preset override with no provenance stamp). */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceProvenanceBadge } from './voice-provenance-badge';

describe('VoiceProvenanceBadge', () => {
  it('renders "My voice" when the slot carries a libraryUuid', () => {
    render(
      <VoiceProvenanceBadge
        slot={{ name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'designed' }}
      />,
    );
    expect(screen.getByTestId('voice-provenance-badge')).toHaveTextContent('My voice');
  });

  it('renders "Designed" when provenance is designed but there is no libraryUuid', () => {
    render(<VoiceProvenanceBadge slot={{ name: 'qwen-bespoke', provenance: 'designed' }} />);
    expect(screen.getByTestId('voice-provenance-badge')).toHaveTextContent('Designed');
  });

  it('renders "Catalogue" for a plain preset override with no provenance stamp', () => {
    render(<VoiceProvenanceBadge slot={{ name: 'Asya Anara' }} />);
    expect(screen.getByTestId('voice-provenance-badge')).toHaveTextContent('Catalogue');
  });

  it('renders "Catalogue" when there is no slot at all', () => {
    render(<VoiceProvenanceBadge slot={undefined} />);
    expect(screen.getByTestId('voice-provenance-badge')).toHaveTextContent('Catalogue');
  });

  it('renders "Cloned" for a cloned slot', () => {
    render(<VoiceProvenanceBadge slot={{ name: 'qwen-x', provenance: 'cloned' }} />);
    expect(screen.getByText('Cloned')).toBeInTheDocument();
  });
});
