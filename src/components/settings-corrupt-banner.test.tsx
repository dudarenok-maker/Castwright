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
});
