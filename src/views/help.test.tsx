// Pairs with the fe-29 offline Help view (src/views/help.tsx).

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice, uiActions } from '../store/ui-slice';
import { settingsSlice, settingsActions } from '../store/settings-slice';
import { tourSlice } from '../store/tour-slice';
import { HelpView } from './help';

vi.mock('../lib/api', () => ({
  api: { loadSample: vi.fn(async () => ({ bookId: 'castwright__standalones__the-coalfall-commission' })) },
}));

function renderHelp(focusCode?: string) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, settings: settingsSlice.reducer },
  });
  store.dispatch(uiActions.openHelp({ focusCode }));
  return render(
    <Provider store={store}>
      <HelpView />
    </Provider>,
  );
}

describe('HelpView (fe-29)', () => {
  it('renders the three sections', () => {
    renderHelp();
    expect(screen.getByRole('heading', { name: /getting started/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /troubleshooting/i })).toBeInTheDocument();
  });

  it('renders a taxonomy entry with What-you-saw / What-to-do', () => {
    renderHelp();
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    expect(screen.getAllByText(/what to do/i).length).toBeGreaterThan(0);
  });

  it('marks the focused entry when focusCode matches', () => {
    renderHelp('vram-spill');
    expect(document.getElementById('vram-spill')).toHaveAttribute('data-focused', 'true');
  });

  it('ignores an unknown focusCode', () => {
    renderHelp('nonsense');
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
  });

  it('shows the live keybindings from the store', () => {
    renderHelp();
    expect(screen.getByText(/play \/ pause/i)).toBeInTheDocument();
  });

  it('reflects a rebound play-pause key', () => {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, settings: settingsSlice.reducer },
    });
    store.dispatch(uiActions.openHelp({}));
    store.dispatch(settingsActions.setKeybinding({ action: 'play-pause', key: 'K' }));
    render(
      <Provider store={store}>
        <HelpView />
      </Provider>,
    );
    /* The play/pause row should now show "K" in its <kbd>, not "Space". */
    const allKbds = document.querySelectorAll('kbd');
    const kKbd = Array.from(allKbds).find((el) => el.textContent === 'K');
    expect(kKbd).toBeInTheDocument();
  });
});

it('Take the tour button starts the linear tour', async () => {
  const store = configureStore({
    reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer, settings: settingsSlice.reducer },
  });
  render(<Provider store={store}><HelpView /></Provider>);
  fireEvent.click(screen.getByRole('button', { name: /take the tour/i }));
  await waitFor(() => expect(store.getState().tour.active).toBe(true));
});
