import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { SettingsCorruptBanner } from './settings-corrupt-banner';
import { accountSlice } from '../store/account-slice';

function makeStore(corrupt: boolean) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        corruptSettingsFile: corrupt,
      },
    },
  });
}

describe('SettingsCorruptBanner', () => {
  it('renders nothing when corruptSettingsFile is false/absent', () => {
    const store = makeStore(false);
    const { container } = render(
      <Provider store={store}>
        <SettingsCorruptBanner />
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the alert when corruptSettingsFile is true', () => {
    const store = makeStore(true);
    const { getByRole } = render(
      <Provider store={store}>
        <SettingsCorruptBanner />
      </Provider>,
    );
    expect(getByRole('alert')).toHaveTextContent(/unreadable and has been reset to defaults/i);
  });

  it('names the artifacts that actually exist for recovery, and not the .bak.N files the server has already proven unparseable', () => {
    /* #3195 pass 2/3: the banner shows iff EVERY `.bak.N` failed to parse, so
       sending the user to `.bak.1/2/3` re-corrupts the file by hand; what does
       exist is the `.corrupt-<timestamp>` snapshot taken on the next save,
       plus whatever system backups they keep. Pins the rewritten half. */
    const store = makeStore(true);
    const { getByRole } = render(
      <Provider store={store}>
        <SettingsCorruptBanner />
      </Provider>,
    );
    const alert = getByRole('alert');
    expect(alert).toHaveTextContent(/user-settings\.json\.corrupt-\s*<timestamp>/);
    expect(alert).toHaveTextContent(/when you next save any settings/i);
    expect(alert).toHaveTextContent(/system backups/i);
    expect(alert).not.toHaveTextContent(/\.bak\.\d/);
  });
});
