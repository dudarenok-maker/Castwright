/* CharacterRegenerateModal — the profile-change regen chooser (plan 114).
   Locks the contract the layout handler depends on: the affected chapters are
   exactly the ones the character speaks in (skipped / absent excluded, reading
   order), and the two footer buttons fire onConfirm with the right `preview`
   flag. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CharacterRegenerateModal } from './character-regenerate';
import type { Character, Chapter } from '../lib/types';

const marlow = { id: 'marlow', name: 'Marlow Halden', color: 'narrator', lines: 120 } as Character;

const ch = (id: number, characters: Record<string, string>): Chapter =>
  ({ id, title: `Chapter ${id}`, duration: '10:00', state: 'done', progress: 1, characters }) as Chapter;

/* Marlow speaks in 1 + 4; ch2 is narrator-only, ch3 has Marlow skipped. */
const chapters = [
  ch(1, { marlow: 'done', narrator: 'done' }),
  ch(2, { narrator: 'done' }),
  ch(3, { marlow: 'skipped', narrator: 'done' }),
  ch(4, { marlow: 'done' }),
];

describe('CharacterRegenerateModal', () => {
  it('lists only the chapters the character speaks in (skipped/absent excluded)', () => {
    render(<CharacterRegenerateModal character={marlow} chapters={chapters} onClose={() => {}} onConfirm={() => {}} />);
    const chips = screen.getByTestId('regen-affected-chapters');
    expect(chips.textContent).toMatch(/CH 01/);
    expect(chips.textContent).toMatch(/CH 04/);
    expect(chips.textContent).not.toMatch(/CH 02/);
    expect(chips.textContent).not.toMatch(/CH 03/);
    /* First affected chapter is tagged as the preview sample. */
    expect(chips.textContent).toMatch(/CH 01preview/);
  });

  it('"Regenerate all" fires onConfirm with every affected chapter and preview:false', () => {
    const onConfirm = vi.fn();
    render(<CharacterRegenerateModal character={marlow} chapters={chapters} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('regen-character-all'));
    expect(onConfirm).toHaveBeenCalledWith({
      characterId: 'marlow',
      chapterIds: [1, 4],
      reason: 'voice',
      note: '',
      preview: false,
    });
  });

  it('"Preview first" fires onConfirm with preview:true (first chapter is the sample)', () => {
    const onConfirm = vi.fn();
    render(<CharacterRegenerateModal character={marlow} chapters={chapters} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('regen-character-preview'));
    expect(onConfirm).toHaveBeenCalledWith({
      characterId: 'marlow',
      chapterIds: [1, 4],
      reason: 'voice',
      note: '',
      preview: true,
    });
  });

  it('disables both actions when the character speaks in no chapters', () => {
    render(
      <CharacterRegenerateModal
        character={marlow}
        chapters={[ch(2, { narrator: 'done' })]}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByTestId('regen-character-all')).toBeDisabled();
    expect(screen.getByTestId('regen-character-preview')).toBeDisabled();
  });

  it('estimates the ETA from the affected chapters audio duration × RTF', () => {
    /* Marlow speaks in ch1 + ch4, each 10:00 → 1200s × 2.5 = 3000s = 50 min. */
    render(
      <CharacterRegenerateModal character={marlow} chapters={chapters} onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.getByText('≈50 min')).toBeInTheDocument();
  });

  it('shows "—" for the ETA when the character speaks in no chapters', () => {
    render(
      <CharacterRegenerateModal
        character={marlow}
        chapters={[ch(2, { narrator: 'done' })]}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
