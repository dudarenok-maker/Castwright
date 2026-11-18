/* Guard (#3712): no test may reach the upgrade path's real pip / npm ci /
   restarter spawn. node:child_process is mocked so even the red run spawns
   nothing real. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// execSync is mocked too: pipInstall -> effectiveProfile -> detectVendor
// (tts-sidecar/scripts/accelerator-profile.mjs) probes the GPU through it,
// and the real one starts powershell/lspci.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  execSync: vi.fn(() => ''),
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { spawn, execSync, exec, execFile } from 'node:child_process';
import { createApplySteps } from './apply.js';

const venvDir = join(tmpdir(), 'apply-no-real-spawn-nonexistent-venv');

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  vi.mocked(execSync).mockClear();
});

describe('createApplySteps never reaches a real spawn under vitest', () => {
  it('G0: running under vitest', () => {
    expect(process.env.VITEST).toBeTruthy();
  });

  // detectVendor short-circuits to 'apple' on darwin without probing, so the
  // GPU probe is only expected off darwin. process.platform is stubbed so both
  // branches run on every CI OS (#4451); the no-real-spawn assertions hold on all.
  describe.each([
    ['darwin', false],
    ['linux', true],
    ['win32', true],
  ])('G1: default pipInstall on %s', (platform, probes) => {
    const realPlatform = process.platform;
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    });

    it(`is refused, spawns nothing, ${probes ? 'probes' : 'does not probe'} the GPU`, async () => {
      const steps = createApplySteps({ venvDir, log: () => {} });
      await expect(steps.pipInstall('/rel')).rejects.toThrow(/real spawn refused under vitest/);
      expect(spawn).toHaveBeenCalledTimes(0);
      if (probes) {
        // The GPU probe reached the mock (proves the mock covers the .mjs
        // import) rather than starting a real powershell/lspci.
        expect(execSync).toHaveBeenCalled();
      } else {
        expect(execSync).toHaveBeenCalledTimes(0);
      }
      expect(exec).toHaveBeenCalledTimes(0);
      expect(execFile).toHaveBeenCalledTimes(0);
    });
  });

  it('G2: npmCi routes through an injected run and never spawns', async () => {
    const run = vi.fn(async (_cmd: string, _args: string[], _cwd: string) => {});
    const steps = createApplySteps({ venvDir, log: () => {} }, { run });
    await steps.npmCi('/rel');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toEqual(['ci']);
    expect(run.mock.calls[1][2]).toBe(join('/rel', 'server'));
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('G3: default npmCi is refused and spawns nothing', async () => {
    const steps = createApplySteps({ venvDir, log: () => {} });
    await expect(steps.npmCi('/rel')).rejects.toThrow(/real spawn refused under vitest/);
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('G4: default spawnRestarter is refused and spawns nothing', () => {
    const steps = createApplySteps({ venvDir, log: () => {} });
    expect(() =>
      steps.spawnRestarter({ installRoot: '/root', releaseDir: '/rel', oldPid: 1 }),
    ).toThrow(/real spawn refused under vitest/);
    expect(spawn).toHaveBeenCalledTimes(0);
  });
});
