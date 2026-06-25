import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { manuscriptSlice } from '../store/manuscript-slice';
import { SentenceInstructControl } from './sentence-instruct-control';
import type { Character } from '../lib/types';

const { markStaleSpy } = vi.hoisted(() => ({ markStaleSpy: vi.fn() }));
vi.mock('../lib/stale-chapters', () => ({ useMarkCharacterStaleIfRendered: () => markStaleSpy }));

function renderControl(props: Partial<React.ComponentProps<typeof SentenceInstructControl>> = {}) {
  const store = configureStore({ reducer: { manuscript: manuscriptSlice.reducer } });
  const spy = vi.spyOn(store, 'dispatch');
  render(
    <Provider store={store}>
      <SentenceInstructControl
        chapterId={1}
        sentenceId={2}
        instruct={undefined}
        character={{ id: 'wren', name: 'Wren', ttsModelKey: 'qwen3-tts-1.7b' } as unknown as Character}
        {...props}
      />
    </Provider>,
  );
  return { store, spy };
}

describe('fs-56 SentenceInstructControl', () => {
  beforeEach(() => {
    markStaleSpy.mockClear();
  });

  it('empty chip has the set-instruct aria-label', () => {
    renderControl();
    expect(screen.getByLabelText('Set delivery direction for this line')).toBeInTheDocument();
  });

  it('a set chip exposes the edit aria-label (accessible name on both states)', () => {
    renderControl({ instruct: 'whisper softly' });
    expect(screen.getByLabelText('Delivery direction: whisper softly — edit')).toBeInTheDocument();
  });

  it('opens pre-filled, focuses the textarea, and Save dispatches the trimmed value', () => {
    const { spy } = renderControl({ instruct: 'whisper softly' });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('whisper softly');      // pre-filled with the current/LLM instruct
    expect(document.activeElement).toBe(ta);       // focus-on-open (a11y)
    fireEvent.change(ta, { target: { value: '  shout it  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manuscript/setSentenceInstruct', payload: expect.objectContaining({ instruct: '  shout it  ' }) }),
    );
  });

  it('Clear dispatches an empty string (reducer deletes the field)', () => {
    const { spy } = renderControl({ instruct: 'x' });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manuscript/setSentenceInstruct', payload: expect.objectContaining({ instruct: '' }) }),
    );
  });

  it('shows the inaudible caption (naming the 1.7B tier) when the speaker is on the 0.6B default', () => {
    renderControl({
      instruct: 'x',
      character: { id: 'n', name: 'N' } as Character,
    });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    expect(screen.getByText(/Qwen 1\.7B tier/i)).toBeInTheDocument();
  });

  it('calls markStale with character id+name on Save when speaker is on 1.7B', () => {
    renderControl({ instruct: 'whisper softly', character: { id: 'wren', name: 'Wren', ttsModelKey: 'qwen3-tts-1.7b' } as unknown as Character });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'shout it' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(markStaleSpy).toHaveBeenCalledOnce();
    expect(markStaleSpy).toHaveBeenCalledWith({ id: 'wren', name: 'Wren' });
  });

  it('does NOT call markStale on Save when speaker is on the 0.6B default', () => {
    renderControl({ instruct: 'whisper softly', character: { id: 'n', name: 'N' } as Character });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'shout it' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(markStaleSpy).not.toHaveBeenCalled();
  });

  it('shows the instruct as audible (not muted) when the speaker is on 1.7B', () => {
    render(
      <Provider store={configureStore({ reducer: { manuscript: manuscriptSlice.reducer } })}>
        <SentenceInstructControl chapterId={1} sentenceId={1} instruct="a whisper"
          character={{ id: 'n', name: 'N', ttsModelKey: 'qwen3-tts-1.7b' } as unknown as Character} />
      </Provider>,
    );
    const chip = screen.getByTestId('instruct-chip');
    expect(chip.className).not.toContain('opacity-50'); // audible
  });

  it('mutes the instruct when the speaker is on the 0.6B default', () => {
    render(
      <Provider store={configureStore({ reducer: { manuscript: manuscriptSlice.reducer } })}>
        <SentenceInstructControl chapterId={1} sentenceId={1} instruct="a whisper"
          character={{ id: 'n', name: 'N' } as Character} />
      </Provider>,
    );
    expect(screen.getByTestId('instruct-chip').className).toContain('opacity-50');
  });
});
