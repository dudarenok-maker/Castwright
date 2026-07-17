import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { BulkReassignUndoBanner } from './bulk-reassign-undo-banner';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';

function makeStore(withSlot: boolean) {
  return configureStore({
    reducer: { manuscript: manuscriptSlice.reducer, changeLog: changeLogSlice.reducer },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [{ chapterId: 1, id: 1, text: 'x', characterId: 'narrator' }] as never,
        lastBulkReassign: withSlot
          ? { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'Narrator' }
          : null,
      },
    },
  });
}

describe('BulkReassignUndoBanner', () => {
  it('renders nothing when the slot is empty', () => {
    const store = makeStore(false);
    const { container } = render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count + target and reverts on Undo, appending a revert event', () => {
    const store = makeStore(true);
    render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(screen.getByText(/1 line.*Narrator/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    const s = store.getState();
    expect(s.manuscript.sentences[0].characterId).toBe('egor');
    expect(s.manuscript.lastBulkReassign).toBeNull();
    expect(s.changeLog.events.some((e) => /revert/i.test(e.note ?? ''))).toBe(true);
    const revertEvent = s.changeLog.events.find((e) => /revert/i.test(e.note ?? ''));
    expect(revertEvent?.title).toBe('Reverted bulk line reassignment');
    expect(revertEvent?.title).not.toMatch(/-1/);
    expect(revertEvent?.title).not.toMatch(/Chapter/);
  });
});
