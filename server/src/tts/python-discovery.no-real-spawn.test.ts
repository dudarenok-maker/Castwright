/* Guard (#3712): findPython312's default probe must refuse under vitest.
   node:child_process is mocked so even the red run spawns nothing real. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

import { spawnSync } from 'node:child_process';
import { findPython312 } from './python-discovery.js';
import { probePython312Cached, _resetPythonProbeCacheForTests } from '../routes/setup-diagnosis.js';

beforeEach(() => {
  vi.mocked(spawnSync).mockClear();
  _resetPythonProbeCacheForTests();
});

describe('findPython312 default probe (#3712)', () => {
  it('P1: refuses a real lookup with no runFn and spawns nothing', () => {
    expect(() => findPython312()).toThrow(/real Python lookup refused under vitest/);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });

  it('P2: an injected runFn still works and spawns nothing', () => {
    const runFn = vi.fn(() => ({ status: 0, stdout: 'Python 3.12.1', stderr: '' }));
    expect(findPython312({ platform: 'linux', runFn })).toEqual({ cmd: 'python3.12', args: [] });
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });

  it('P3: probePython312Cached refuses the real lookup', () => {
    expect(() => probePython312Cached()).toThrow(/real Python lookup refused under vitest/);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });
});
