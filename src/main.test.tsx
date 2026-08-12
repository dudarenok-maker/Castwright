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
    /* #2276 — the `await import('./main')` above sits INSIDE the test body, so
       transforming and loading the app's whole dependency graph into jsdom is
       billed against testTimeout rather than against a hook. That is the whole
       reason this test needs its own budget.

       Measured cost is ~2.6-2.9s (7 runs across two sessions, `tests` from
       vitest's own summary), NOT the ~5s an earlier revision of this comment
       claimed. #2276 read `tests 5.00s` off a run that was either loaded or had
       already timed out at the 5000ms default, and that figure was never
       reproduced — so the "zero timing margin" premise in the issue is wrong
       too; the real margin against the default was ~1.8x.

       30s is therefore deliberate headroom for a loaded box (this repo runs
       concurrent batteries across worktrees), NOT an estimate of what the test
       costs. Do not tune it down toward the measured cost — that would restore
       the failure mode #2276 was filed for.

       Whether the ~2.7s is reducible is untested: the issue listed "find out
       why and reduce it" as an option and nobody ran it. Unknown, not refuted. */
    30_000
  );
});
