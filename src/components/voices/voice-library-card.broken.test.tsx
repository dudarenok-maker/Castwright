/* fs-38 Wave 3b2, Task 9 — Broken/Repairable state chip on cloned
   voice-library cards.

   The server (Task 1-8 of this wave) now resolves a cloned voice's Qwen
   model per-chapter and fails loud when it's Broken. This is the frontend
   early-warning: the My-voices library card surfaces the same Broken /
   Repairable state so the user isn't surprised at render time.

   Broken:     consent.revokedAt set, OR master absent, OR
               engines.qwen.status === 'failed'.
   Repairable: engines.qwen.status === 'stale' (self-heals next render).
   Neither:    a healthy cloned entry shows no extra chip. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice, type VoiceLibraryEntry } from '../../store/voice-library-slice';
import { VoiceLibraryCard, deriveClonedVoiceState } from './voice-library-card';

const MASTER = {
  clipFile: 'master.wav',
  sampleRate: 24_000,
  durationSeconds: 12,
  transcript: 'demo',
  transcriptSource: 'whisper' as const,
  captureMethod: 'record' as const,
};

const CONSENT = {
  personName: 'Mum',
  relationship: 'family-with-permission' as const,
  permittedUse: 'personal' as const,
  attestedAt: '2026-07-20T00:00:00Z',
  attestedBy: 'me',
};

function makeCloned(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'c1',
    name: 'Mum',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: { qwen: { status: 'ready' } },
    consent: CONSENT,
    master: MASTER,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

function renderCard(entry: VoiceLibraryEntry) {
  const store = configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer },
    preloadedState: {
      voiceLibrary: {
        entries: [entry],
        status: 'ready' as const,
        designPending: false,
        clonePending: false,
        lastFetchedAt: Date.now(),
      },
    },
  });
  render(
    <Provider store={store}>
      <VoiceLibraryCard entry={entry} />
    </Provider>,
  );
}

describe('deriveClonedVoiceState', () => {
  it('is "broken" when consent.revokedAt is set', () => {
    expect(
      deriveClonedVoiceState(makeCloned({ consent: { ...CONSENT, revokedAt: '2026-07-25T00:00:00Z' } })),
    ).toBe('broken');
  });

  it('is "broken" when master is absent', () => {
    expect(deriveClonedVoiceState(makeCloned({ master: undefined }))).toBe('broken');
  });

  it('is "broken" when engines.qwen.status is "failed"', () => {
    expect(deriveClonedVoiceState(makeCloned({ engines: { qwen: { status: 'failed' } } }))).toBe(
      'broken',
    );
  });

  it('is "repairable" when engines.qwen.status is "stale"', () => {
    expect(deriveClonedVoiceState(makeCloned({ engines: { qwen: { status: 'stale' } } }))).toBe(
      'repairable',
    );
  });

  it('is null for a healthy cloned entry', () => {
    expect(deriveClonedVoiceState(makeCloned())).toBeNull();
  });
});

describe('VoiceLibraryCard — cloned Broken/Repairable chip', () => {
  it('shows the danger "Needs attention" chip when consent is revoked', () => {
    const entry = makeCloned({ consent: { ...CONSENT, revokedAt: '2026-07-25T00:00:00Z' } });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-card-clonestate-${entry.voiceUuid}`)).toHaveTextContent(
      'Needs attention',
    );
  });

  it('shows the danger "Needs attention" chip when engines.qwen.status is failed', () => {
    const entry = makeCloned({ engines: { qwen: { status: 'failed' } } });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-card-clonestate-${entry.voiceUuid}`)).toHaveTextContent(
      'Needs attention',
    );
  });

  it('shows the danger "Needs attention" chip when master is missing', () => {
    const entry = makeCloned({ master: undefined });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-card-clonestate-${entry.voiceUuid}`)).toHaveTextContent(
      'Needs attention',
    );
  });

  it('shows the warning "Will re-derive" chip for a stale cloned entry', () => {
    const entry = makeCloned({ engines: { qwen: { status: 'stale' } } });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-card-clonestate-${entry.voiceUuid}`)).toHaveTextContent(
      'Will re-derive',
    );
  });

  it('renders neither chip for a healthy cloned entry', () => {
    const entry = makeCloned();
    renderCard(entry);
    expect(
      screen.queryByTestId(`voice-library-card-clonestate-${entry.voiceUuid}`),
    ).not.toBeInTheDocument();
  });
});
