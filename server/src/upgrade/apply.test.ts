/* fs-1 — pin applyUpgrade's orchestration + rollback with fully faked steps:
   - happy path runs extract → npm ci → (conditional) pip → flip → restart,
   - pip is skipped when the requirements hash is unchanged,
   - a pre-flip failure does NOT flip the pointer and clears the partial dir. */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { applyUpgrade, type ApplySteps, type ApplyContext } from './apply.js';

function ctx(over: Partial<ApplyContext> = {}): ApplyContext {
  return {
    installRoot: '/install',
    releasesDir: '/install/releases',
    stagedZipPath: '/install/.upgrade-staging/incoming.zip',
    topDir: 'castwright-v1.6.0',
    candidateVersion: '1.6.0',
    reqHash: 'hash-new',
    oldPid: 4242,
    ...over,
  };
}

function fakeSteps(over: Partial<ApplySteps> = {}): ApplySteps {
  return {
    rmDir: vi.fn(async () => {}),
    exists: vi.fn(() => false),
    extract: vi.fn(async () => {}),
    npmCi: vi.fn(async () => {}),
    pipInstall: vi.fn(async () => {}),
    readReqHash: vi.fn(() => 'hash-old'),
    writeReqHash: vi.fn(),
    flipPointer: vi.fn(async () => {}),
    spawnRestarter: vi.fn(),
    ...over,
  };
}

describe('applyUpgrade', () => {
  it('runs the full sequence and flips the pointer last', async () => {
    const steps = fakeSteps();
    const res = await applyUpgrade(ctx(), steps);
    expect(res.ok).toBe(true);
    expect(res.phase).toBe('done');
    expect(res.releaseDir).toBe(join('/install/releases', 'v1.6.0'));
    expect(steps.extract).toHaveBeenCalledOnce();
    expect(steps.npmCi).toHaveBeenCalledOnce();
    expect(steps.pipInstall).toHaveBeenCalledOnce(); // hash-new != hash-old
    expect(steps.writeReqHash).toHaveBeenCalledWith('hash-new');
    expect(steps.flipPointer).toHaveBeenCalledWith('/install', '1.6.0');
    expect(steps.spawnRestarter).toHaveBeenCalledWith({
      installRoot: '/install',
      releaseDir: join('/install/releases', 'v1.6.0'),
      oldPid: 4242,
    });
    expect(res.pipRan).toBe(true);
  });

  it('skips pip when the requirements hash is unchanged', async () => {
    const steps = fakeSteps({ readReqHash: vi.fn(() => 'same') });
    const res = await applyUpgrade(ctx({ reqHash: 'same' }), steps);
    expect(res.ok).toBe(true);
    expect(steps.pipInstall).not.toHaveBeenCalled();
    expect(res.pipRan).toBe(false);
  });

  it('clears a leftover partial candidate dir before extracting', async () => {
    const steps = fakeSteps({ exists: vi.fn(() => true) });
    await applyUpgrade(ctx(), steps);
    expect(steps.rmDir).toHaveBeenCalledWith(join('/install/releases', 'v1.6.0'));
  });

  it('does NOT flip the pointer when extraction fails, and clears the partial dir', async () => {
    const steps = fakeSteps({ extract: vi.fn(async () => { throw new Error('corrupt zip'); }) });
    const res = await applyUpgrade(ctx(), steps);
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('extract');
    expect(res.error).toContain('corrupt zip');
    expect(steps.flipPointer).not.toHaveBeenCalled();
    expect(steps.spawnRestarter).not.toHaveBeenCalled();
  });

  it('does NOT flip when npm ci fails', async () => {
    const steps = fakeSteps({ npmCi: vi.fn(async () => { throw new Error('npm ci exited 1'); }) });
    const res = await applyUpgrade(ctx(), steps);
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('npm-ci');
    expect(steps.flipPointer).not.toHaveBeenCalled();
  });
});
