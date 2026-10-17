import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { SettingsCorruptBanner } from './settings-corrupt-banner';
import { accountSlice } from '../store/account-slice';

function makeStore(corrupt: boolean, unreadable = false) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        corruptSettingsFile: corrupt,
        settingsFileUnreadable: unreadable,
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

  /* #3625 pass 4: a locked / unreadable (not corrupt) settings file is its own
     state — values may be defaults and saves are refused, but nothing was reset
     and no .corrupt snapshot is coming, so the corruption copy would be wrong. */
  it('renders the unreadable-file alert, not the corruption copy, when settingsFileUnreadable is true', () => {
    const store = makeStore(false, true);
    const { getByRole } = render(
      <Provider store={store}>
        <SettingsCorruptBanner />
      </Provider>,
    );
    const alert = getByRole('alert');
    expect(alert).toHaveTextContent(/can't be read right now/i);
    expect(alert).toHaveTextContent(/changes won't be saved/i);
    expect(alert).toHaveTextContent(/close any program that might be locking it/i);
    expect(alert).not.toHaveTextContent(/reset to defaults/i);
  });

  it('shows the corruption copy when both flags are set (the reset is the bigger news)', () => {
    const store = makeStore(true, true);
    const { getByRole } = render(
      <Provider store={store}>
        <SettingsCorruptBanner />
      </Provider>,
    );
    expect(getByRole('alert')).toHaveTextContent(/reset to defaults/i);
  });
});
