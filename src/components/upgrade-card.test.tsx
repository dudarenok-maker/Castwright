import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import type { UpdateStatus } from '../lib/types';

/* useAppInfo → a fixed running version. */
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: { appVersion: '1.6.0', sidecarVersion: '1.6.0' }, error: null, refresh: vi.fn() }),
}));

/* api.getUpdateStatus is the only api call the card makes on mount. */
const h = vi.hoisted(() => ({ getUpdateStatus: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { getUpdateStatus: h.getUpdateStatus } }));

import { upgradeSlice } from '../store/upgrade-slice';
import { UpgradeCard } from './upgrade-card';

function renderCard() {
  const store = configureStore({ reducer: { upgrade: upgradeSlice.reducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <UpgradeCard />
      </MemoryRouter>
    </Provider>,
  );
}

const status = (over: Partial<UpdateStatus>): UpdateStatus => ({
  reachable: true,
  currentVersion: '1.6.0',
  latestVersion: '1.6.0',
  updateAvailable: false,
  url: null,
  ...over,
});

beforeEach(() => {
  h.getUpdateStatus.mockReset();
});

describe('UpgradeCard — update-check states', () => {
  it('shows "Update available" + a primary Apply when a newer release exists', async () => {
    h.getUpdateStatus.mockResolvedValue(
      status({ latestVersion: '1.7.0', updateAvailable: true, url: 'https://x/releases/1.7.0' }),
    );
    renderCard();
    await waitFor(() => expect(screen.getByTestId('update-available')).toBeInTheDocument());
    expect(screen.getByTestId('update-available')).toHaveTextContent('v1.7.0');
    expect(screen.getByRole('button')).toHaveTextContent('Apply update package…');
  });

  it('shows "up to date" + a demoted manual-apply when on the latest', async () => {
    h.getUpdateStatus.mockResolvedValue(status({ latestVersion: '1.6.0', updateAvailable: false }));
    renderCard();
    await waitFor(() => expect(screen.getByTestId('up-to-date')).toBeInTheDocument());
    expect(screen.queryByTestId('update-available')).toBeNull();
    expect(screen.getByRole('button')).toHaveTextContent('Apply a package manually…');
  });

  it('FAILS OPEN: an unreachable check shows neither banner, just the manual apply', async () => {
    h.getUpdateStatus.mockResolvedValue(
      status({ reachable: false, latestVersion: null, updateAvailable: false }),
    );
    renderCard();
    // running version always renders; give the effect a tick to settle.
    await waitFor(() => expect(screen.getByText(/You're running/)).toBeInTheDocument());
    expect(screen.queryByTestId('update-available')).toBeNull();
    expect(screen.queryByTestId('up-to-date')).toBeNull();
    expect(screen.getByRole('button')).toHaveTextContent('Apply a package manually…');
  });

  it('does not throw when the check rejects (client-side fail-open)', async () => {
    h.getUpdateStatus.mockRejectedValue(new Error('network'));
    renderCard();
    await waitFor(() => expect(screen.getByText(/You're running/)).toBeInTheDocument());
    expect(screen.queryByTestId('update-available')).toBeNull();
  });
});
