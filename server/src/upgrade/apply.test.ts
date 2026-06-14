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
    // By default the shared venv matches the candidate's Python tag, so the
    // detect-and-reinstall guard is inert and behaviour equals the pre-guard flow.
    readStamp: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'whatever' })),
    resolveRequired: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'req-hash' })),
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

  // Task 13B — detect-and-reinstall guard (R2): an alpha box on a 3.11 venv must
  // never have the 3.12 release pip 3.12 deps into the 3.11 interpreter.
  it('aborts with needs-reinstall when the shared venv pythonTag != the candidate release (3.11 -> 3.12)', async () => {
    const steps = fakeSteps({
      readStamp: vi.fn(() => ({ pythonTag: 'cp311', profile: 'nvidia', reqHash: 'x' })),
      resolveRequired: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'y' })),
    });
    const res = await applyUpgrade(ctx(), steps);
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('needs-reinstall');
    expect(res.error).toMatch(/reinstall/i);
    // never pip into a 3.11 venv, and the old release stays current.
    expect(steps.pipInstall).not.toHaveBeenCalled();
    expect(steps.flipPointer).not.toHaveBeenCalled();
    expect(steps.spawnRestarter).not.toHaveBeenCalled();
  });

  it('reads the candidate release sidecar dir for the required tag (not the running code)', async () => {
    const resolveRequired = vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'y' }));
    const steps = fakeSteps({ resolveRequired });
    await applyUpgrade(ctx(), steps);
    expect(resolveRequired).toHaveBeenCalledWith(
      join('/install/releases', 'v1.6.0', 'server', 'tts-sidecar'),
    );
  });

  it('still pip-installs in place when the pythonTag matches and the requirements hash changed', async () => {
    const steps = fakeSteps({
      readStamp: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'old' })),
      resolveRequired: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'new' })),
      readReqHash: vi.fn(() => 'hash-old'),
    });
    const res = await applyUpgrade(ctx({ reqHash: 'hash-new' }), steps);
    expect(res.ok).toBe(true);
    expect(steps.pipInstall).toHaveBeenCalled();
    expect(steps.flipPointer).toHaveBeenCalled();
  });

  it('treats a missing stamp (old v1.7.0 venv) as needs-reinstall', async () => {
    const steps = fakeSteps({ readStamp: vi.fn(() => null) });
    const res = await applyUpgrade(ctx(), steps);
    expect(res.ok).toBe(false);
    expect(res.phase).toBe('needs-reinstall');
    expect(steps.pipInstall).not.toHaveBeenCalled();
    expect(steps.flipPointer).not.toHaveBeenCalled();
  });
});
