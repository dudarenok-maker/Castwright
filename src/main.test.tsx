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

       Measured cost is ~2.6-3.1s on a lightly-loaded box (`tests`, from
       vitest's own summary), NOT the ~5s an earlier revision of this comment
       claimed. But quote that with its conditions, because the number moves a
       lot: ~3.6-4.3s with an unrelated CPU-heavy process resident and NO
       concurrent test battery, and higher still under the concurrent battery
       #2276 actually documents. So the margin against the 5000ms default is
       ~1.8x idle, ~1.2x under moderate load, and under 1.0x -- i.e. a failure --
       under the condition that produced the bug. The issue's "zero timing
       margin" framing is wrong about an idle box and substantially right about
       a busy one.

       Where #2276's `tests 5.00s` came from, mechanically: `retry: 1` is set in
       vitest.config.ts, and vitest captures a test's start ONCE before its
       retry loop and computes `duration` after it -- so duration is CUMULATIVE
       across attempts. Attempt 1 timing out at 5000ms plus a near-free retry
       (the module graph is already in the worker's cache, so the second
       `import('./main')` does no transform) reports a PASSING test at ~5.00s
       with a ~7.6s wall total, which is exactly the `duration 7.62s total /
       tests 5.00s` pair the issue recorded. It was never a measurement of what
       this test costs.

       30s is therefore deliberate headroom for a loaded box (this repo runs
       concurrent batteries across worktrees), NOT an estimate of what the test
       costs. Do not tune it down toward the measured cost — that would restore
       the failure mode #2276 was filed for.

       Whether the ~2.7s is reducible is untested: the issue listed "find out
       why and reduce it" as an option and nobody ran it. Unknown, not refuted. */
    30_000
  );
});
