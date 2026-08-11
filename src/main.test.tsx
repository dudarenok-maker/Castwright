// fe-56 — react-router 8 folded react-router-dom back into react-router, but
// split RouterProvider (and HydratedRouter) into a DOM-specific export:
// react-router/dom's RouterProvider wraps the bare react-router one with
// `flushSync: ReactDOM.flushSync` wiring (see node_modules/react-router/dist/
// development/lib/dom-export/dom-router-provider.js). Both modules export a
// component named RouterProvider, and dom-router-provider.d.ts declares
// Omit<RouterProviderProps, "flushSync">, so importing the wrong one compiles
// AND typechecks. This test pins main.tsx (the app's sole RouterProvider mount
// site) to the DOM-specific export.
//
// Honest severity: today the wrong import would behave identically. flushSync
// is consumed only behind `if (reactDomFlushSyncImpl && flushSync)`, and this
// app uses no viewTransition and no flushSync, so the miss degrades to a
// dev-only warnOnce. This guard exists for the moment that stops being true —
// adopt view transitions with the bare import and navigations silently stop
// flushing, with nothing else in the suite to catch it.

import { describe, expect, it, vi } from 'vitest';

const domRouterProviderMock = vi.hoisted(() => vi.fn(() => null));
const bareRouterProviderMock = vi.hoisted(() => vi.fn(() => null));

vi.mock('react-router/dom', () => ({
  RouterProvider: domRouterProviderMock,
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, RouterProvider: bareRouterProviderMock };
});

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('main.tsx router wiring (fe-56)', () => {
  it(
    "mounts with react-router/dom's RouterProvider, not the bare react-router export",
    async () => {
      document.body.innerHTML = '<div id="root"></div>';
      stubMatchMedia();

      await import('./main');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(domRouterProviderMock).toHaveBeenCalled();
      expect(bareRouterProviderMock).not.toHaveBeenCalled();
    },
    // Importing main.tsx pulls the entire application dependency graph into jsdom (~5s on an idle box).
    // This is genuine work required to verify the real RouterProvider import, not a bug to optimize away.
    30_000
  );
});
