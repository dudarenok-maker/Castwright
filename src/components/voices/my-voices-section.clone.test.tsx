import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../../lib/api', () => ({
  api: { listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }) },
}));
// Stub the wizard so this test is a pure "CTA mounts the wizard" check.
vi.mock('../../modals/clone-voice-wizard', () => ({
  CloneVoiceWizard: () => <div data-testid="clone-voice-wizard" />,
}));

import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { MyVoicesSection } from './my-voices-section';

function renderSection() {
  const store = configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
  render(
    <Provider store={store}>
      <MyVoicesSection enabled />
    </Provider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('MyVoicesSection — clone CTA', () => {
  it('opens the clone wizard when the Clone-a-voice CTA is clicked', () => {
    renderSection();
    expect(screen.queryByTestId('clone-voice-wizard')).toBeNull();
    fireEvent.click(screen.getByTestId('my-voices-clone-cta'));
    expect(screen.getByTestId('clone-voice-wizard')).toBeInTheDocument();
  });
});
