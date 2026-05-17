import { installTimestamps } from './lib/logger';
installTimestamps();

import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { store } from './store';
import { router } from './routes';
import { ErrorBoundary } from './components/error-boundary';
import './styles.css';

/* Expose the store on window for DEV + e2e builds so Playwright specs
   (and interactive dev-time inspection) can read Redux state via
   `page.evaluate(() => window.__store__.getState())`. The branch is
   tree-shaken in production builds — `import.meta.env.DEV` is `false`
   and `MODE === 'e2e'` is `false` for `vite build`. Documented in
   docs/features/37-e2e-playwright.md under "Test hooks". */
if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') {
  (window as unknown as { __store__: typeof store }).__store__ = store;
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Provider store={store}><RouterProvider router={router}/></Provider>
  </ErrorBoundary>
);
