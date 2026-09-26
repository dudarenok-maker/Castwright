/* #3084 F7 — the persistent reasoning-overflow notification.

   Two things distinguish this toast from every other one, and this file pins
   both: it has NO auto-dismiss timer (ToastItem owns that 6 s timer and this
   component deliberately does not), and it renders the failed run's structured
   "How to fix" list. The routing decision that sends a `fixes` toast here
   rather than through ToastItem is covered by toast-stack.test.tsx; this file
   covers the component's own behaviour, mirroring voice-nudge-toast.test.tsx. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ReasoningOverflowToast } from './reasoning-overflow-toast';
import { notificationsSlice, type Toast } from '../store/notifications-slice';

function makeStore(toast: Toast) {
  return configureStore({
    reducer: { notifications: notificationsSlice.reducer },
    preloadedState: { notifications: { toasts: [toast] } },
  });
}

const toast: Toast = {
  id: 'f1',
  kind: 'error',
  message: 'Gemini stopped after 65536 output tokens without finishing.',
  createdAt: 0,
  dedupeKey: 'analysis-stream',
  fixes: [
    {
      label: 'Lower Gemini max input tokens per request',
      settingKey: 'analyzer.gemini.maxInputTokensPerRequest',
    },
    { label: 'Switch to a different analyzer model' },
    {
      label: 'Read: When a model thinks past its output limit',
      wikiPage: 'Analysis-and-the-Analyzer',
    },
  ],
};

describe('ReasoningOverflowToast (#3084 F7)', () => {
  it('renders the failure message and its "How to fix" list', () => {
    const store = makeStore(toast);
    render(
      <Provider store={store}>
        <ReasoningOverflowToast toast={toast} />
      </Provider>,
    );
    expect(screen.getByText(toast.message)).toBeTruthy();
    expect(screen.getByText('How to fix:')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('does not auto-dismiss: still on screen 6 s after mount (fake clock)', () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(toast);
      render(
        <Provider store={store}>
          <ReasoningOverflowToast toast={toast} />
        </Provider>,
      );
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      /* The whole point of this component: ToastItem's 6 s timer would have
         dropped a plain toast by now, and this one is pushed exactly when the
         user has navigated away from the run that failed. */
      expect(store.getState().notifications.toasts).toHaveLength(1);
      expect(screen.getByText('How to fix:')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the dismiss button removes the toast — the user, not a timer, closes it', () => {
    const store = makeStore(toast);
    render(
      <Provider store={store}>
        <ReasoningOverflowToast toast={toast} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));
    expect(store.getState().notifications.toasts).toHaveLength(0);
  });

  it('renders the message with no list when the toast carries no fixes', () => {
    const bare: Toast = { ...toast, fixes: undefined };
    const store = makeStore(bare);
    render(
      <Provider store={store}>
        <ReasoningOverflowToast toast={bare} />
      </Provider>,
    );
    expect(screen.getByText(bare.message)).toBeTruthy();
    expect(screen.queryByText('How to fix:')).toBeNull();
  });
});
