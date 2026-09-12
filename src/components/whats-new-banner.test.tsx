/* fs-1 — pin the what's-new banner: hidden unless showWhatsNew, renders the
   version + notes, dismiss calls the API + refreshes. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../store/account-slice';

const h = vi.hoisted(() => ({
  info: null as null | Record<string, unknown>,
  refresh: vi.fn(async () => {}),
  dismissWhatsNew: vi.fn(async () => ({ ok: true, corruptSettingsFile: false })),
}));

vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: h.refresh }),
}));
vi.mock('../lib/api', () => ({ api: { dismissWhatsNew: h.dismissWhatsNew } }));

/* No mock of '../store': useAppDispatch resolves through the react-redux
   context, so the <Provider> around each render is sufficient — the same
   plain-Provider pattern as settings-corrupt-banner.test.tsx (#3195 R1). */

import { WhatsNewBanner } from './whats-new-banner';

let sharedStore: ReturnType<typeof makeStore>;

function makeStore() {
  return configureStore({
    reducer: {
      account: accountSlice.reducer,
    },
  });
}

beforeEach(() => {
  sharedStore = makeStore();
  h.info = null;
  // Clear (not reassign) so the references captured by the vi.mock factories
  // stay valid across tests.
  h.refresh.mockClear();
  h.dismissWhatsNew.mockClear();
});

describe('WhatsNewBanner', () => {
  it('renders nothing when showWhatsNew is false', () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: false, releaseNotes: '' };
    const { container } = render(
      <Provider store={sharedStore}>
        <MemoryRouter>
          <WhatsNewBanner />
        </MemoryRouter>
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the version + release notes when showWhatsNew is true', () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '# v1.6.0\n- In-app upgrades' };
    render(
      <Provider store={sharedStore}>
        <MemoryRouter>
          <WhatsNewBanner />
        </MemoryRouter>
      </Provider>,
    );
    expect(screen.getByTestId('whats-new-banner')).toBeInTheDocument();
    expect(screen.getByText(/What's new in v1\.6\.0/)).toBeInTheDocument();
    expect(screen.getByText(/In-app upgrades/)).toBeInTheDocument();
  });

  it('dismiss calls the API and refreshes', async () => {
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '' };
    render(
      <Provider store={sharedStore}>
        <MemoryRouter>
          <WhatsNewBanner />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(h.dismissWhatsNew).toHaveBeenCalledOnce());
    expect(h.refresh).toHaveBeenCalled();
  });

  it('P2 — dismiss with corruptSettingsFile: true updates the Redux store', async () => {
    // When dismissWhatsNew returns corruptSettingsFile: true, the Redux store
    // must be updated to reflect the corruption state.
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '' };
    h.dismissWhatsNew.mockResolvedValueOnce({ ok: true, corruptSettingsFile: true });

    render(
      <Provider store={sharedStore}>
        <MemoryRouter>
          <WhatsNewBanner />
        </MemoryRouter>
      </Provider>,
    );

    // Initial state should be false
    expect(sharedStore.getState().account.corruptSettingsFile).toBe(false);

    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(h.dismissWhatsNew).toHaveBeenCalledOnce());

    // After dismissWhatsNew succeeds with corruptSettingsFile: true,
    // the store must be updated
    expect(sharedStore.getState().account.corruptSettingsFile).toBe(true);
  });

  it('Q1 — a dismiss that succeeds without a readable flag still refreshes (the server-side dismiss must not be reported as a failure)', async () => {
    /* An older server, a 204, or a body-stripping proxy: the POST succeeded
       but there is no `corruptSettingsFile` to read. Before #3195 this call
       never read the body, so this must stay a success path — the refresh
       runs and the store is left alone. */
    h.info = { appVersion: '1.6.0', showWhatsNew: true, releaseNotes: '' };
    h.dismissWhatsNew.mockResolvedValueOnce(undefined as never);
    sharedStore.dispatch(accountSlice.actions.setCorruptSettingsFile(true));

    render(
      <Provider store={sharedStore}>
        <MemoryRouter>
          <WhatsNewBanner />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(h.dismissWhatsNew).toHaveBeenCalledOnce());

    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    // No flag in the response → the store's flag is untouched, not clobbered to undefined.
    expect(sharedStore.getState().account.corruptSettingsFile).toBe(true);
  });
});
