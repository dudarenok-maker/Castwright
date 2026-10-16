import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { DroppedEndpointEntriesBanner } from './dropped-endpoint-entries-banner';
import { api } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, acknowledgeDroppedEndpointEntries: vi.fn() } };
});

const ARCHIVED = { archiveId: 'a1', kind: 'endpoint', endpointId: 'lab', name: 'Lab', issues: ['analyzerEndpoints.0.baseUrl: invalid_format'], droppedAt: '2026-09-13T10:00:00.000Z' };
const PENDING = { archiveId: null, kind: 'key', endpointId: 'box', origin: 'http://10.0.0.5:8080', issues: ['analyzerEndpointKeys.box.key: invalid_type'], droppedAt: '2026-09-13T10:00:00.000Z' };

function renderBanner(entries: unknown[]) {
  const store = configureStore({ reducer: { account: accountSlice.reducer } });
  store.dispatch({ type: 'account/fetch/fulfilled', payload: { hydrated: true, droppedEndpointEntries: entries } });
  render(
    <Provider store={store}>
      <DroppedEndpointEntriesBanner />
    </Provider>,
  );
  return store;
}

describe('DroppedEndpointEntriesBanner (#3084 P31)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when no entry was dropped', () => {
    renderBanner([]);
    expect(screen.queryByTestId('dropped-endpoint-banner')).toBeNull();
  });

  it('names the entry, what was wrong, why it was removed and where the copy is', () => {
    renderBanner([ARCHIVED]);
    const banner = screen.getByTestId('dropped-endpoint-banner');
    expect(banner).toHaveTextContent('Endpoint "Lab"');
    expect(banner).toHaveTextContent('analyzerEndpoints.0.baseUrl: invalid_format');
    expect(banner).toHaveTextContent('so the rest of your settings still load');
    expect(banner).toHaveTextContent('user-settings.invalid-endpoints.json');
  });

  it('"Got it" acknowledges that entry by its archive id, and the banner clears when the server stops listing it', async () => {
    vi.mocked(api.acknowledgeDroppedEndpointEntries).mockResolvedValue({ droppedEndpointEntries: [] } as never);
    renderBanner([ARCHIVED]);
    fireEvent.click(screen.getByTestId('dropped-endpoint-ack-a1'));
    await waitFor(() => expect(api.acknowledgeDroppedEndpointEntries).toHaveBeenCalledWith(['a1']));
    await waitFor(() => expect(screen.queryByTestId('dropped-endpoint-banner')).toBeNull());
  });

  it('an entry whose archive copy is still pending is shown, says so, and cannot be acknowledged', () => {
    renderBanner([PENDING, ARCHIVED]);
    const [pending] = screen.getAllByTestId('dropped-endpoint-entry');
    expect(pending).toHaveTextContent('The API key for endpoint "box" (http://10.0.0.5:8080)');
    expect(pending).toHaveTextContent('analyzerEndpointKeys.box.key: invalid_type');
    expect(pending).toHaveTextContent('archive copy is still pending');
    expect(screen.getAllByRole('button', { name: 'Got it' })).toHaveLength(1);
    expect(screen.getByTestId('dropped-endpoint-ack-a1')).toBeInTheDocument();
  });
});
