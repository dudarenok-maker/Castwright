/* Guard (#3712): no test may reach bootstrap-venv.mjs's real `pip install`.
   node:child_process is mocked so even the red run spawns nothing real. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import { spawnSync } from 'node:child_process';
import {
  installForProfile,
  // @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
} from '../../tts-sidecar/scripts/bootstrap-venv.mjs';

beforeEach(() => {
  vi.mocked(spawnSync).mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('installForProfile never reaches a real pip install under vitest', () => {
  it('G0: running under vitest', () => {
    expect(process.env.VITEST).toBeTruthy();
  });

  it('G1: the default runPip is refused and spawnSync is never called', () => {
    expect(() =>
      installForProfile('C:/nonexistent-venv/python.exe', 'cpu', undefined, 'win32', null),
    ).toThrow(
      'installForProfile: real pip install refused under vitest (#3712); inject runPip',
    );
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });

  it('G2: an injected runPip still works', () => {
    const calls: string[][] = [];
    installForProfile(
      'C:/nonexistent-venv/python.exe',
      'cpu',
      (a: string[]) => {
        calls.push(a);
        return true;
      },
      'win32',
      null,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });
});
