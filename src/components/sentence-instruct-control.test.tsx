import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { manuscriptSlice } from '../store/manuscript-slice';
import { SentenceInstructControl } from './sentence-instruct-control';
import type { Character } from '../lib/types';

vi.mock('../lib/stale-chapters', () => ({ useMarkCharacterStaleIfRendered: () => vi.fn() }));

function renderControl(props: Partial<React.ComponentProps<typeof SentenceInstructControl>> = {}) {
  const store = configureStore({ reducer: { manuscript: manuscriptSlice.reducer } });
  const spy = vi.spyOn(store, 'dispatch');
  render(
    <Provider store={store}>
      <SentenceInstructControl
        chapterId={1}
        sentenceId={2}
        instruct={undefined}
        character={{ id: 'wren', name: 'Wren', ttsEngine: 'qwen' } as unknown as Character}
        liveInstruct={true}
        {...props}
      />
    </Provider>,
  );
  return { store, spy };
}

describe('fs-56 SentenceInstructControl', () => {
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

  it('shows the inaudible caption (naming the 1.7B tier) when liveInstruct is off', () => {
    renderControl({ instruct: 'x', liveInstruct: false });
    fireEvent.click(screen.getByRole('button', { name: /delivery direction/i }));
    expect(screen.getByText(/Qwen 1\.7B tier with Live expressive delivery on/i)).toBeInTheDocument();
  });
});
