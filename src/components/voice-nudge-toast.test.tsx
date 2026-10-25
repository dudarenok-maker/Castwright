import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { VoiceNudgeToast } from './voice-nudge-toast';
import { notificationsSlice, type Toast } from '../store/notifications-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { accountSlice } from '../store/account-slice';
import { configSlice } from '../store/config-slice';
import { haltActiveGeneration } from '../store/queue-thunks';
import { seedSameCardPersona } from '../test/seed-same-card-persona';

/* The guard's Confirm dispatches haltActiveGeneration; stub it to a plain action so the test asserts the call. */
vi.mock('../store/queue-thunks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/queue-thunks')>()),
  haltActiveGeneration: vi.fn(() => ({ type: 'test/haltActiveGeneration' })),
}));

// Recording middleware — the idiomatic way to assert designAllRequested fired
// (its reducer is a no-op; real interception lives in middleware not installed here).
const recorded: { type: string; payload: unknown }[] = [];
const recorder = () => (next: (a: unknown) => unknown) => (a: unknown) => {
  recorded.push(a as { type: string; payload: unknown });
  return next(a);
};

const makeStore = (designRunning: boolean, roster: { id: string; voiceStyle?: string }[] = []) => {
  recorded.length = 0;
  return configureStore({
    reducer: {
      cast: castSlice.reducer,
      notifications: notificationsSlice.reducer,
      castDesign: castDesignSlice.reducer,
      chapters: chaptersSlice.reducer,
      account: accountSlice.reducer,
      config: configSlice.reducer,
    },
    preloadedState: {
      cast: { ...castSlice.getInitialState(), characters: roster as never },
      notifications: { toasts: [] },
      castDesign: { active: designRunning ? ({ state: 'running', bookId: 'b1' } as never) : null },
    },
    middleware: (gdm) => gdm().concat(recorder),
  });
};

const toast: Toast = {
  id: 't1', kind: 'info', message: 'New character «Mara» needs a voice', createdAt: 0,
  dedupeKey: 'off-roster-voice-nudge:b1',
  nudge: { bookId: 'b1', characterIds: ['mara'], modelKey: 'qwen3-tts-0.6b', names: ['Mara'] },
};

describe('VoiceNudgeToast', () => {
  it('idle: tapping the button dispatches designAllRequested and dismisses the toast', () => {
    const store = makeStore(false);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));

    const design = recorded.find((a) => a.type === 'castDesign/designAllRequested');
    expect(design).toBeTruthy();
    expect((design!.payload as { characterIds: string[] }).characterIds).toEqual(['mara']);
    expect((design!.payload as { scope: string }).scope).toBe('bases');
    expect((design!.payload as { modelKey: string }).modelKey).toBe('qwen3-tts-0.6b');
    expect(recorded.some((a) => a.type === 'notifications/dismissToast')).toBe(true);
  });

  it('busy: button is disabled and the nudge is NOT dismissed', () => {
    const store = makeStore(true);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    const btn = screen.getByRole('button', { name: /design now/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/a voice design is already running/i)).toBeTruthy();
  });

  it('plural copy when several characters need voices', () => {
    const store = makeStore(false);
    const plural: Toast = {
      ...toast,
      nudge: { ...toast.nudge!, characterIds: ['mara', 'tom'], names: ['Mara', 'Tom'] },
    };
    render(<Provider store={store}><VoiceNudgeToast toast={plural} /></Provider>);
    expect(screen.getByText(/2 new characters need voices/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /design all/i })).toBeTruthy();
  });
});

describe('VoiceNudgeToast — design guard (#3084 W4)', () => {
  it('a same-card endpoint persona engine with a render streaming asks first; Confirm halts, then designs and dismisses', async () => {
    const store = makeStore(false);
    seedSameCardPersona(store);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));

    expect(screen.getByText('Pause audio generation to design voices?')).toBeInTheDocument();
    expect(recorded.some((a) => a.type === 'castDesign/designAllRequested')).toBe(false);
    /* The design starts once the halt has settled, a microtask later. */
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause and design' }));
    });
    expect(haltActiveGeneration).toHaveBeenCalledTimes(1);
    expect(recorded.some((a) => a.type === 'castDesign/designAllRequested')).toBe(true);
    expect(recorded.some((a) => a.type === 'notifications/dismissToast')).toBe(true);
  });

  it('every nudged character already has a voice description: no persona is generated, so it designs at once with no prompt', () => {
    const store = makeStore(false, [{ id: 'mara', voiceStyle: 'a dry contralto' }]);
    seedSameCardPersona(store);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));
    expect(screen.queryByText('Pause audio generation to design voices?')).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    expect(recorded.some((a) => a.type === 'castDesign/designAllRequested')).toBe(true);
  });

  it('one nudged character without a voice description still asks', () => {
    const store = makeStore(false, [{ id: 'mara', voiceStyle: 'a dry contralto' }, { id: 'tom', voiceStyle: '' }]);
    seedSameCardPersona(store);
    const plural: Toast = { ...toast, nudge: { ...toast.nudge!, characterIds: ['mara', 'tom'], names: ['Mara', 'Tom'] } };
    render(<Provider store={store}><VoiceNudgeToast toast={plural} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design all/i }));
    expect(screen.getByText('Pause audio generation to design voices?')).toBeInTheDocument();
  });

  it('Wait leaves the toast and starts nothing', () => {
    const store = makeStore(false);
    seedSameCardPersona(store);
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));
    /* The DESIGN dialog must be the one asking: with design mode off the guard falls back to the analysis
       dialog (also has a Wait button), and a Wait that only checks "nothing started" passes either way. */
    expect(screen.getByText('Pause audio generation to design voices?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(screen.queryByText('Pause audio generation to design voices?')).not.toBeInTheDocument();
    expect(recorded.some((a) => a.type === 'castDesign/designAllRequested')).toBe(false);
    expect(recorded.some((a) => a.type === 'notifications/dismissToast')).toBe(false);
  });

  it('a Gemini persona engine designs at once with no dialog', () => {
    const store = makeStore(false);
    seedSameCardPersona(store, { personaEngine: 'gemini' });
    render(<Provider store={store}><VoiceNudgeToast toast={toast} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /design now/i }));
    expect(screen.queryByText('Pause audio generation to design voices?')).not.toBeInTheDocument();
    expect(recorded.some((a) => a.type === 'castDesign/designAllRequested')).toBe(true);
  });
});
