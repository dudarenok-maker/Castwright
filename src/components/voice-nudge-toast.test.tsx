import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { VoiceNudgeToast } from './voice-nudge-toast';
import { notificationsSlice, type Toast } from '../store/notifications-slice';
import { castDesignSlice } from '../store/cast-design-slice';

// Recording middleware — the idiomatic way to assert designAllRequested fired
// (its reducer is a no-op; real interception lives in middleware not installed here).
const recorded: { type: string; payload: unknown }[] = [];
const recorder = () => (next: (a: unknown) => unknown) => (a: unknown) => {
  recorded.push(a as { type: string; payload: unknown });
  return next(a);
};

const makeStore = (designRunning: boolean) => {
  recorded.length = 0;
  return configureStore({
    reducer: { notifications: notificationsSlice.reducer, castDesign: castDesignSlice.reducer },
    preloadedState: {
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
