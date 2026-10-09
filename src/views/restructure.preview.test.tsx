/* Plan 286 (OD31) — a restructure of the preview's book clears the preview. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice, uiActions } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { castSlice } from '../store/cast-slice';

const { holder, apiMock } = vi.hoisted(() => ({
  holder: { store: null as null | { getState: () => unknown } },
  apiMock: { refreshChapterTitles: vi.fn(), getBookState: vi.fn(), getLibrary: vi.fn() },
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: apiMock }));
vi.mock('../store', async () => {
  const rr = await import('react-redux');
  return { useAppDispatch: rr.useDispatch, useAppSelector: rr.useSelector, store: { getState: () => holder.store!.getState() } };
});

import { RestructureView } from './restructure';

function makeStore() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, library: librarySlice.reducer, notifications: notificationsSlice.reducer, cast: castSlice.reducer } });
  holder.store = store;
  store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' } as never));
  return store;
}
const preview = (bookId: string) => ({ bookId, characterId: 'c', previewChapterId: 1, remainingChapterIds: [], reason: '', note: '', completed: { reviewOutcome: 'none' as const, stubFallback: true } });

beforeEach(() => {
  apiMock.refreshChapterTitles.mockReset().mockResolvedValue({ sentenceRemap: [], warnings: [] });
  apiMock.getBookState.mockReset().mockResolvedValue(null);
  apiMock.getLibrary.mockReset().mockResolvedValue(null);
});

async function refreshTitles(store: ReturnType<typeof makeStore>) {
  render(<Provider store={store}><RestructureView bookId="b1" /></Provider>);
  fireEvent.click(screen.getByTestId('restructure-refresh-titles'));
  fireEvent.click(await screen.findByTestId('restructure-confirm-apply'));
  await waitFor(() => expect(apiMock.refreshChapterTitles).toHaveBeenCalledWith('b1'));
  await waitFor(() => expect(apiMock.getLibrary).toHaveBeenCalled()); // applyResponse ran to its end
}

describe('RestructureView — OD31', () => {
  it("a restructure of the preview's book clears the preview", async () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(preview('b1')));
    await refreshTitles(store);
    expect(store.getState().ui.previewRegen).toBeNull();
  });
});
