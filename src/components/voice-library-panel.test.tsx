/* Cast-view interaction regression: clicking a voice card in the Voice
   Library panel must open the profile drawer for the character that uses
   that voice, and clicking the swatch bubble must trigger a voice sample
   for that character. Pre-fix the panel was drag-only. */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { VoiceLibraryPanel } from './voice-library-panel';
import type { Character, Voice } from '../lib/types';

const makeVoice = (id: string, character: string, overrides: Partial<Voice> = {}): Voice => ({
  id, character,
  bookTitle: 'the Coalfall Commission', bookId: 'bks',
  attributes: ['Warm'], gradient: ['#A43C6C', '#3C194F'],
  usedIn: 1, source: 'current',
  ttsVoice: { provider: 'coqui', name: 'Claribel Dervla', description: '' },
  ...overrides,
});

const makeCharacter = (id: string, voiceId: string, overrides: Partial<Character> = {}): Character => ({
  id, name: id, role: 'role', color: id,
  voiceState: 'generated', voiceId,
  ...overrides,
});

describe('VoiceLibraryPanel — Cast-view interactions', () => {
  it('opens the profile drawer for the character that uses the clicked voice', () => {
    const onOpenProfile = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_Marlow', 'Marlow'), makeVoice('v_ro', 'Ro')]}
        characters={[makeCharacter('Marlow', 'v_Marlow'), makeCharacter('ro', 'v_ro')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Marlow').closest('[role="button"]')!);
    expect(onOpenProfile).toHaveBeenCalledWith('Marlow');
  });

  it('plays a voice sample (not opens the drawer) when the swatch bubble is clicked', () => {
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_Marlow', 'Marlow')]}
        characters={[makeCharacter('Marlow', 'v_Marlow')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />
    );
    const card = screen.getByText('Marlow').closest('[role="button"]')!;
    fireEvent.click(within(card as HTMLElement).getAllByRole('button')[0]);
    expect(onPlaySample).toHaveBeenCalledTimes(1);
    expect(onPlaySample.mock.calls[0][0].id).toBe('Marlow');
    expect(onPlaySample.mock.calls[0][1].id).toBe('v_Marlow');
    /* The swatch click must NOT bubble to the card root and double-fire
       onOpenProfile — the panel's user expectation is "bubble plays,
       card opens" as two distinct actions. */
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('stays drag-only for series voices with no character in the current book', () => {
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    /* A voice from another book in the series — no character in the
       current book uses it, so the panel should not synthesise a drawer
       or sample target. The library tab is "library" because that's what
       series voices use; switch to All so the test sees it. */
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_series', 'Other-book speaker', { source: 'library', bookTitle: 'Earlier Book', bookId: 'eb' })]}
        characters={[]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />
    );
    const card = screen.getByText('Other-book speaker').closest('div.group')!;
    expect(card.getAttribute('role')).toBeNull();
    fireEvent.click(card);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('matches voices to characters by character.id when voiceId is unset (fresh-analysis regression)', () => {
    /* Real bug: the analyzer never emits voiceId on a character, and the
       server derives Voice.id from `character.voiceId ?? character.id`. So
       for a freshly-analysed book Voice.id === character.id, and a
       voiceId-only match always misses — leaving every panel card inert.
       Pin the fallback so the regression can't reappear silently. */
    const onOpenProfile = vi.fn();
    const onPlaySample = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('Marlow', 'Marlow')]}            /* Voice.id mirrors character.id */
        characters={[makeCharacter('Marlow', '')]}          /* character has no voiceId */
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={onPlaySample}
      />
    );
    const card = screen.getByText('Marlow').closest('[role="button"]')!;
    fireEvent.click(card);
    expect(onOpenProfile).toHaveBeenCalledWith('Marlow');
    fireEvent.click(within(card as HTMLElement).getAllByRole('button')[0]);
    expect(onPlaySample.mock.calls[0][0].id).toBe('Marlow');
  });

  it('prefers an explicit voiceId match over the character.id fallback', () => {
    /* Two characters: one whose id collides with another character's
       voiceId. The explicit voiceId mapping must win — otherwise reused
       library voices would open the wrong drawer. */
    const onOpenProfile = vi.fn();
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_shared', 'Shared voice')]}
        characters={[
          makeCharacter('different-char', 'v_shared'), /* explicit voiceId match */
          makeCharacter('v_shared', ''),               /* id collides with the voice id */
        ]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
        onOpenProfile={onOpenProfile}
        onPlaySample={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Shared voice').closest('[role="button"]')!);
    expect(onOpenProfile).toHaveBeenCalledWith('different-char');
  });

  it('falls back to drag-only behaviour when no callbacks are supplied (Library view path)', () => {
    /* The Voices/Library view reuses VoiceCard without the Cast-view
       handlers. Without callbacks, the card must not present itself as
       a button — otherwise screen readers announce a non-interactive
       affordance. */
    render(
      <VoiceLibraryPanel
        library={[makeVoice('v_Marlow', 'Marlow')]}
        draggingVoiceId={null}
        setDraggingVoiceId={vi.fn()}
      />
    );
    const card = screen.getByText('Marlow').closest('div.group')!;
    expect(card.getAttribute('role')).toBeNull();
  });
});
