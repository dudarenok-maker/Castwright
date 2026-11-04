// #3713 / PR #4004 pass 6 -- main.tsx must read the repair epoch as the page loads. Every other suite calls
// `loadRepairEpoch()` itself and nothing else imports main.tsx, so deleting the call there left them all green
// while every page in production sent no epoch (and was reloaded, then blocked, at its first gated write).
// This boots the real main.tsx and pins the call -- and its mock-mode exemption.

import { afterEach, describe, expect, it, vi } from 'vitest';

const loadRepairEpochMock = vi.hoisted(() => vi.fn());

vi.mock('./lib/repair-epoch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/repair-epoch')>();
  return { ...actual, loadRepairEpoch: loadRepairEpochMock };
});

vi.mock('react-router/dom', () => ({ RouterProvider: vi.fn(() => null) }));

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

async function boot(): Promise<void> {
  vi.resetModules();
  loadRepairEpochMock.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  stubMatchMedia();
  await import('./main');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('main.tsx reads the repair epoch at page load (#3713)', () => {
  it('against a real server (mocks off) it calls loadRepairEpoch exactly once', async () => {
    vi.stubEnv('VITE_USE_MOCKS', 'false');
    await boot();
    expect(loadRepairEpochMock).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('in mock mode there is no server to ask, so it does not', async () => {
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    await boot();
    expect(loadRepairEpochMock).not.toHaveBeenCalled();
  }, 60_000);
});
