import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../lib/api', () => ({
  api: { listVoiceLibrary: () => Promise.resolve({ voices: [] }), cloneVoiceSample: vi.fn(), revokeVoiceLibraryEntry: vi.fn() },
}));
// The wizard's Name / Save step only shows once the capture panel reports ready,
// so stand the panel in with a button that does exactly that.
vi.mock('../components/voices/clone-capture-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/voices/clone-capture-panel')>();
  return {
    ...actual,
    CloneCapturePanel: (p: { onReady: (r: unknown) => void }) => (
      <button
        type="button"
        onClick={() =>
          p.onReady({
            candidateId: 'c',
            transcript: 't',
            consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
          })
        }
      >
        stub-ready
      </button>
    ),
  };
});

import { HELP_TOPICS } from './help-topics';
import { voiceLibrarySlice } from '../store/voice-library-slice';
import { uiSlice } from '../store/ui-slice';
import { MyVoicesSection } from '../components/voices/my-voices-section';
import { VoiceLibraryCard } from '../components/voices/voice-library-card';
import { CloneVoiceWizard } from '../modals/clone-voice-wizard';

const { CloneCapturePanel: RealPanel } = await vi.importActual<
  typeof import('../components/voices/clone-capture-panel')
>('../components/voices/clone-capture-panel');

const body = HELP_TOPICS.find((t) => t.id === 'clone-your-own-voice')!.body;
const store = () =>
  configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer, ui: uiSlice.reducer } });
const wrap = (ui: React.ReactNode) => <Provider store={store()}>{ui}</Provider>;

/* The Help topic quotes UI labels verbatim. Each one is asserted twice: present
   in the topic body, and present in the component that renders it, so renaming
   either side without the other fails here instead of shipping a stale Help. */
describe('clone-your-own-voice topic quotes live UI labels', () => {
  it('relationship options, tabs and Continue match CloneCapturePanel', () => {
    render(wrap(<RealPanel onReady={() => {}} />));
    for (const label of ['This is my own voice', 'A family member, with their permission', 'My child (I’m their guardian)']) {
      expect(body).toContain(label);
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
    for (const name of ['Record', 'Upload']) {
      expect(body).toContain(name);
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(body).toContain('Continue');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('Clone a voice matches the My voices call to action', () => {
    render(wrap(<MyVoicesSection />));
    expect(body).toContain('Clone a voice');
    expect(screen.getByRole('button', { name: 'Clone a voice' })).toBeInTheDocument();
  });

  it('Name and Save match the clone wizard', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    render(wrap(<CloneVoiceWizard onClose={() => {}} />));
    await userEvent.click(screen.getByRole('button', { name: 'stub-ready' }));
    expect(body).toContain('name the voice and Save');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('Revoke matches the cloned voice card', () => {
    render(
      wrap(
        <VoiceLibraryCard
          entry={{
            voiceUuid: 'c1',
            name: 'Mum',
            provenance: 'cloned',
            tags: [],
            pinned: false,
            engines: {},
            consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal', attestedAt: 'x', attestedBy: 'Mum' },
            createdAt: 'x',
            updatedAt: 'x',
          }}
        />,
      ),
    );
    expect(body).toContain('Revoke a voice');
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});
