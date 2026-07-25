import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { VoiceLibraryCard } from './voice-library-card';

// listVoiceLibrary must return { voices: [...] } (reducer reads payload.voices), even if unused here
vi.mock('../../lib/api', () => ({
  api: { listVoiceLibrary: () => Promise.resolve({ voices: [] }), revokeVoiceLibraryEntry: vi.fn() },
}));

const store = () => configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
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
});
