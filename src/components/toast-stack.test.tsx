/* ToastStack — fixed bottom-right notification surface for transient
   errors / warnings / info. Tests render shape, dedupe rendering,
   close-button dismiss, and the 6 s auto-dismiss timer. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ToastStack } from './toast-stack';
import { notificationsSlice, notificationsActions, type Toast } from '../store/notifications-slice';
import { castDesignSlice } from '../store/cast-design-slice';

vi.mock('../store', async () => {
  const actual = await vi.importActual<typeof import('../store')>('../store');
  return {
    ...actual,
    useAppDispatch: () => sharedStore.dispatch,
    useAppSelector: <T,>(sel: (s: ReturnType<typeof sharedStore.getState>) => T): T =>
      sel(sharedStore.getState()),
  };
});

let sharedStore: ReturnType<typeof makeStore>;

function makeStore() {
  return configureStore({
    reducer: { notifications: notificationsSlice.reducer, castDesign: castDesignSlice.reducer },
  });
}

function makeStoreWithToast(toast: Toast) {
  return configureStore({
    reducer: { notifications: notificationsSlice.reducer, castDesign: castDesignSlice.reducer },
    preloadedState: {
      notifications: { toasts: [toast] },
      castDesign: { active: null },
    },
  });
}

beforeEach(() => {
  sharedStore = makeStore();
});

describe('ToastStack — render', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one item per toast and shows the message text', () => {
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: 'export failed' }),
    );
    sharedStore.dispatch(notificationsActions.pushToast({ kind: 'info', message: 'all clear' }));
    render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    expect(screen.getByText(/export failed/i)).toBeInTheDocument();
    expect(screen.getByText(/all clear/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a single toast when two pushes share a dedupeKey', () => {
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: 'first', dedupeKey: 'k' }),
    );
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: 'second', dedupeKey: 'k' }),
    );
    render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    // Only the most recent (deduped) message renders.
    expect(screen.queryByText(/first/i)).not.toBeInTheDocument();
    expect(screen.getByText(/second/i)).toBeInTheDocument();
  });
});

describe('ToastStack — close button', () => {
  it('dismisses the toast when the X is clicked', () => {
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'warn', message: 'will go away' }),
    );
    render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    expect(screen.getByText(/will go away/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));
    expect(sharedStore.getState().notifications.toasts).toHaveLength(0);
  });
});

describe('ToastStack — auto-dismiss timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the toast after the 6 s window elapses', () => {
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: 'transient' }),
    );
    render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    expect(sharedStore.getState().notifications.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(sharedStore.getState().notifications.toasts).toHaveLength(0);
  });

  it('does not fire dismiss before the timer elapses', () => {
    sharedStore.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: 'still here' }),
    );
    render(
      <Provider store={sharedStore}>
        <ToastStack />
      </Provider>,
    );
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(sharedStore.getState().notifications.toasts).toHaveLength(1);
  });
});

describe('ToastStack — nudge routing', () => {
  it('renders a nudge toast via VoiceNudgeToast and does not auto-dismiss it', () => {
    vi.useFakeTimers();
    const store = makeStoreWithToast({
      id: 'n1', kind: 'info', message: 'New character «Mara» needs a voice', createdAt: Date.now(),
      nudge: { bookId: 'b1', characterIds: ['mara'], modelKey: 'qwen3-tts-0.6b', names: ['Mara'] },
    });
    // Override sharedStore so the mock's useAppSelector/useAppDispatch see the new store
    sharedStore = store as ReturnType<typeof makeStore>;
    render(<Provider store={store}><ToastStack /></Provider>);
    expect(screen.getByRole('button', { name: /design now/i })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(7000); });
    // still present after the 6s window — nudge toasts are sticky
    expect(screen.getByRole('button', { name: /design now/i })).toBeTruthy();
    vi.useRealTimers();
  });
});
