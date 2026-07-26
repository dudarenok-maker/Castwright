import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { uiSlice } from '../../store/ui-slice';
import { VoiceLibraryCard } from './voice-library-card';
import { api } from '../../lib/api';

// listVoiceLibrary must return { voices: [...] } (reducer reads payload.voices), even if unused here
vi.mock('../../lib/api', () => ({
  api: { listVoiceLibrary: () => Promise.resolve({ voices: [] }), revokeVoiceLibraryEntry: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(api.revokeVoiceLibraryEntry).mockClear();
});

const store = () =>
  configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer, ui: uiSlice.reducer } });
const cloned = {
  voiceUuid: 'c1',
  name: 'Mum',
  provenance: 'cloned' as const,
  tags: [],
  pinned: false,
  engines: {},
  consent: {
    personName: 'Mum',
    relationship: 'family-with-permission' as const,
    permittedUse: 'personal' as const,
    attestedAt: 'x',
    attestedBy: 'me',
  },
  createdAt: 'x',
  updatedAt: 'x',
};

describe('VoiceLibraryCard — cloned provenance', () => {
  it('shows a cloned voice with its badge and a Revoke action', () => {
    render(
      <Provider store={store()}>
        <VoiceLibraryCard entry={cloned} />
      </Provider>,
    );
    expect(screen.getByText('Cloned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  /* User-directed fix — revoke now also erases the recording, so it must
     require a genuine two-step confirm (not a single click) before
     dispatching. Clicking Revoke alone must NOT call revokeVoiceLibraryEntry. */
  it('clicking Revoke opens a confirm dialog without dispatching revokeVoice', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={store()}>
        <VoiceLibraryCard entry={cloned} />
      </Provider>,
    );

    await user.click(screen.getByTestId('voice-library-revoke-c1'));

    expect(screen.getByRole('heading', { name: /revoke "mum"\?/i })).toBeInTheDocument();
    expect(api.revokeVoiceLibraryEntry).not.toHaveBeenCalled();
  });

  it('the confirm dialog copy names the voice and states every consequence', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={store()}>
        <VoiceLibraryCard entry={cloned} />
      </Provider>,
    );

    await user.click(screen.getByTestId('voice-library-revoke-c1'));

    const heading = screen.getByRole('heading', { name: /revoke "mum"\?/i });
    const text = heading.closest('.bg-white')!.textContent!;
    expect(text).toMatch(/mum/i); // names the voice
    expect(text).toMatch(/used or played/i); // can no longer be used/played
    expect(text).toMatch(/permanently deleted/i); // recording + derived artifacts gone
    expect(text).toMatch(/can.t be undone/i); // irreversibility
    expect(text).toMatch(/fail to render until reassigned/i); // cast-character impact
  });

  it('confirming in the dialog dispatches revokeVoice exactly once', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={store()}>
        <VoiceLibraryCard entry={cloned} />
      </Provider>,
    );

    await user.click(screen.getByTestId('voice-library-revoke-c1'));
    await user.click(screen.getByRole('button', { name: /revoke & delete recording/i }));

    expect(api.revokeVoiceLibraryEntry).toHaveBeenCalledTimes(1);
    expect(api.revokeVoiceLibraryEntry).toHaveBeenCalledWith('c1');
  });

  it('cancelling the dialog closes it without dispatching revokeVoice', async () => {
    const user = userEvent.setup();
    render(
      <Provider store={store()}>
        <VoiceLibraryCard entry={cloned} />
      </Provider>,
    );

    await user.click(screen.getByTestId('voice-library-revoke-c1'));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('heading', { name: /revoke "mum"\?/i })).not.toBeInTheDocument();
    expect(api.revokeVoiceLibraryEntry).not.toHaveBeenCalled();
  });
});
