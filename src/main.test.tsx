// fe-56 — react-router 8 folded react-router-dom back into react-router, but
// split RouterProvider (and HydratedRouter) into a DOM-specific export:
// react-router/dom's RouterProvider wraps the bare react-router one with
// `flushSync: ReactDOM.flushSync` wiring (see node_modules/react-router/dist/
// development/lib/dom-export/dom-router-provider.js). Both modules export a
// component named RouterProvider, so importing the wrong one still compiles
// and typechecks — it only breaks at runtime. This test pins main.tsx (the
// app's sole RouterProvider mount site) to the DOM-specific export.

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
  it("mounts with react-router/dom's RouterProvider, not the bare react-router export", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    stubMatchMedia();

    await import('./main');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(domRouterProviderMock).toHaveBeenCalled();
    expect(bareRouterProviderMock).not.toHaveBeenCalled();
  });
});
