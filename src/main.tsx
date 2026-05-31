import { installTimestamps } from './lib/logger';
installTimestamps();

import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { store } from './store';
import { router } from './routes';
import { ErrorBoundary } from './components/error-boundary';
import './styles.css';

/* Plan 41 — pre-mount paint guard. Reads the persisted ui-slice blob
   from localStorage and sets <html data-theme> BEFORE React mounts so
   dark-mode users don't see a one-frame white flash on cold boot.
   redux-persist hydrates async, which is too late to avoid the flash.
   The account-default fallback is intentionally NOT read here — the
   account hasn't fetched yet, so a system-prefer-dark user with
   override=null and account=light gets dark for one frame before
   useTheme() corrects to light. Accepted single-frame correction. */
(function applyPreMountTheme() {
  try {
    const raw = window.localStorage.getItem('persist:ui');
    if (!raw) {
      document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';
      return;
    }
    const wrapper = JSON.parse(raw) as Record<string, string>;
    /* redux-persist double-encodes each key as JSON inside the wrapper. */
    const themeOverride = wrapper.themeOverride
      ? (JSON.parse(wrapper.themeOverride) as 'light' | 'dark' | 'system' | null)
      : null;
    const mode =
      themeOverride ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : mode;
  } catch {
    /* localStorage disabled or JSON malformed — fall through with no
       attribute set. styles.css :root tokens cover the light default. */
  }
})();

/* Expose the store on window for DEV + e2e builds so Playwright specs
   (and interactive dev-time inspection) can read Redux state via
   `page.evaluate(() => window.__store__.getState())`. The branch is
   tree-shaken in production builds — `import.meta.env.DEV` is `false`
   and `MODE === 'e2e'` is `false` for `vite build`. Documented in
   docs/features/archive/37-e2e-playwright.md under "Test hooks". */
if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') {
  (window as unknown as { __store__: typeof store }).__store__ = store;
  /* Plan 111 — let e2e specs seed/reset the in-memory mock queue (the queue
     drives generation in mock mode). Same DEV/e2e gate as __store__. */
  void import('./mocks/mock-queue').then(({ seedMockQueue, resetMockQueue }) => {
    (window as unknown as { __mockQueue: unknown }).__mockQueue = {
      seed: seedMockQueue,
      reset: resetMockQueue,
    };
  });
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </ErrorBoundary>,
);
