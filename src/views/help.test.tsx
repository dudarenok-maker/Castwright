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

  it('opens the Setup group by default and leaves others collapsed', () => {
    renderHelp();
    // setup item visible…
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    // …a performance-group item is NOT mounted (group collapsed)
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });

  it('expands a group on header click and shows failure-card labels', () => {
    renderHelp();
    fireEvent.click(screen.getByRole('button', { name: /performance & gpu/i }));
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    // failure cards carry the What-you-saw / What-to-do labels (topic cards do not)
    expect(screen.getAllByText(/what to do/i).length).toBeGreaterThan(0);
  });

  it('mounts and marks the focused entry inside its auto-expanded group', () => {
    renderHelp('vram-spill'); // performance
    const el = document.getElementById('vram-spill');
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute('data-focused', 'true');
  });

  it('ignores an unknown focusCode (setup still the only open group)', () => {
    renderHelp('nonsense');
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });

  it('filters items by search text and hides non-matching groups', () => {
    renderHelp();
    fireEvent.change(screen.getByRole('searchbox', { name: /search troubleshooting/i }), {
      target: { value: 'vram' },
    });
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    expect(screen.queryByText("The app won't start")).toBeNull();
  });

  it('shows a result count and clears back to grouped view', () => {
    renderHelp();
    const box = screen.getByRole('searchbox', { name: /search troubleshooting/i });
    fireEvent.change(box, { target: { value: 'gpu' } });
    expect(screen.getByText(/of 43/i)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    // back to default: setup open, performance collapsed
    expect(screen.getByText("The app won't start")).toBeInTheDocument();
    expect(screen.queryByText('GPU out of memory (VRAM)')).toBeNull();
  });

  it('renders section-level and per-category wiki links', () => {
    renderHelp();
    const links = screen.getAllByRole('link', { name: /read more on the wiki/i });
    // at least the 3 section links + setup category link are present on first render
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Getting-Started');
    expect(hrefs).toContain('https://github.com/dudarenok-maker/Castwright/wiki/Troubleshooting');
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
