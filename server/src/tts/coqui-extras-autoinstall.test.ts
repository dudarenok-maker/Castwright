/* #4961 — the boot-time Coqui text-splitting auto-install trigger. Offline:
   probe / install / listening / installed-state are all injected. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensureCoquiTextSplitPackages,
  getCoquiExtrasNotice,
  _resetCoquiExtrasNotice,
  type CoquiExtrasDeps,
} from './coqui-extras-autoinstall.js';

function makeDeps(over: Partial<CoquiExtrasDeps> = {}) {
  const probeFn = vi.fn(async () => false); // false = packages missing
  const installFn = vi.fn(async () => {});
  const deps: CoquiExtrasDeps = {
    repoRoot: '/repo',
    autoStart: true,
    coquiInstalledFn: () => true,
    sidecarListeningFn: async () => false,
    probeFn,
    installFn,
    log: () => {},
    warn: () => {},
    ...over,
  };
  return { deps, probeFn, installFn };
}

beforeEach(() => _resetCoquiExtrasNotice());

describe('ensureCoquiTextSplitPackages (#4961)', () => {
  it('installs once when Coqui is installed, the sidecar is down and the packages are missing', async () => {
    const { deps, installFn } = makeDeps();
    expect(await ensureCoquiTextSplitPackages(deps)).toBe('installed');
    expect(installFn).toHaveBeenCalledTimes(1);
    expect(getCoquiExtrasNotice()?.status).toBe('installed');
  });

  it('does nothing when the packages are already importable', async () => {
    const { deps, installFn } = makeDeps({ probeFn: vi.fn(async () => true) });
    expect(await ensureCoquiTextSplitPackages(deps)).toBe('present');
    expect(installFn).not.toHaveBeenCalled();
    expect(getCoquiExtrasNotice()).toBeNull();
  });

  it('does not probe or install when Coqui is not installed', async () => {
    const { deps, probeFn, installFn } = makeDeps({ coquiInstalledFn: () => false });
    expect(await ensureCoquiTextSplitPackages(deps)).toBe('skipped-no-coqui');
    expect(probeFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });

  it('does nothing when the server will not auto-start the sidecar (next start retries)', async () => {
    const { deps, probeFn, installFn } = makeDeps({ autoStart: false });
    expect(await ensureCoquiTextSplitPackages(deps)).toBe('skipped-no-autostart');
    expect(probeFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });

  it('never touches the venv while a sidecar is already listening (it holds the DLLs)', async () => {
    const { deps, probeFn, installFn } = makeDeps({ sidecarListeningFn: async () => true });
    expect(await ensureCoquiTextSplitPackages(deps)).toBe('skipped-sidecar-running');
    expect(probeFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });

  it('a failed install resolves (never rejects), leaves a failed notice, and Coqui is untouched', async () => {
    const warn = vi.fn();
    const { deps } = makeDeps({
      installFn: vi.fn(async () => {
        throw new Error('pip exploded');
      }),
      warn,
    });
    await expect(ensureCoquiTextSplitPackages(deps)).resolves.toBe('failed');
    const n = getCoquiExtrasNotice();
    expect(n?.status).toBe('failed');
    expect(n?.message).toMatch(/Coqui still works/);
    expect(n?.message).not.toMatch(/pip exploded/); // raw error stays in the log
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pip exploded'));
  });

  it('a probe that throws is contained (resolves failed, no install)', async () => {
    const { deps, installFn } = makeDeps({
      probeFn: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(ensureCoquiTextSplitPackages(deps)).resolves.toBe('failed');
    expect(installFn).not.toHaveBeenCalled();
  });

  it('shows an installing notice while the install runs', async () => {
    let during: string | undefined;
    const { deps } = makeDeps({
      installFn: vi.fn(async () => {
        during = getCoquiExtrasNotice()?.status;
      }),
    });
    await ensureCoquiTextSplitPackages(deps);
    expect(during).toBe('installing');
  });
});
