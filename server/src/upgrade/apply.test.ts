/* fs-1 — pin applyUpgrade's orchestration + rollback with fully faked steps:
   - happy path runs extract → npm ci → (conditional) pip → flip → restart,
   - pip is skipped when the requirements hash is unchanged,
   - a pre-flip failure does NOT flip the pointer and clears the partial dir. */

import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FS_FAILURE_REQUEST_ERROR, FS_PERMANENT_FAILURE_REQUEST_ERROR } from '../workspace/file-lock.js';
import { applyUpgrade, createApplySteps, type ApplySteps, type ApplyContext } from './apply.js';

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
    // UX guarantee (AMD phase 2): the reinstall path — the same one a profile
    // switch takes, since the in-place rebuild was descoped — MUST reassure the
    // user their content survives, so the message can't read as data loss.
    expect(res.error).toMatch(/books and voices are preserved/i);
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
  // #4322 — errorLan is the curated twin of error for LAN clients.
  describe('errorLan (#4322)', () => {
    const P = 'C:\\Users\\bob\\app\\releases\\v1.2.3';
    const fsErr = (code: string, msg = `EBUSY: resource busy, rename '${P}'`) =>
      Object.assign(new Error(msg), { code, syscall: 'rename', path: P });

    it('curates an EBUSY fs error while error stays raw', async () => {
      const steps = fakeSteps({ extract: vi.fn(async () => { throw fsErr('EBUSY'); }) });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('bob');
      expect(res.errorLan).toBe(FS_FAILURE_REQUEST_ERROR);
      expect(res.errorLan).not.toContain('bob');
      expect(res.errorLan).not.toContain('C:');
    });

    it('maps ENOSPC to the permanent-failure sentence', async () => {
      const steps = fakeSteps({ extract: vi.fn(async () => { throw fsErr('ENOSPC', 'ENOSPC: no space left'); }) });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.errorLan).toBe(FS_PERMANENT_FAILURE_REQUEST_ERROR);
    });

    it('gives a phase with no STEP_FAILURE_LAN entry a fixed sentence, not its raw message', async () => {
      // log() runs after phase flips to 'needs-reinstall' (no map entry), so a throw there lands in the catch.
      const steps = fakeSteps({
        readStamp: vi.fn(() => null),
        log: (m: string) => {
          if (m.includes('reinstall required')) throw new Error(`boom ${P}`);
        },
      });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.phase).toBe('needs-reinstall');
      expect(res.error).toContain('bob');
      expect(res.errorLan).toBe('The upgrade failed. See the server log for details.');
      expect(res.errorLan).not.toContain('bob');
    });

    it('passes a plain extract-phase Error through verbatim', async () => {
      const steps = fakeSteps({ extract: vi.fn(async () => { throw new Error('corrupt zip'); }) });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.errorLan).toBe('corrupt zip');
    });

    // run()'s real rejection format: `${cmd} ${args.join(' ')} exited ${code}`.
    const NO_PATH = /[\\/]|[A-Za-z]:/;
    it.each([
      [
        'windows',
        'C:\\Users\\bob\\Castwright\\venv\\Scripts\\python.exe -m pip install -r C:\\Users\\bob\\Castwright\\releases\\v1.6.0\\server\\tts-sidecar\\requirements\\nvidia-cuda.txt exited 1',
      ],
      [
        'posix',
        '/home/bob/castwright/venv/bin/python -m pip install -r /home/bob/castwright/releases/v1.6.0/server/tts-sidecar/requirements/nvidia-cuda.txt exited 1',
      ],
    ])('keeps absolute paths out of errorLan for a failed pip step (%s)', async (_n, raw) => {
      const steps = fakeSteps({ pipInstall: vi.fn(async () => { throw new Error(raw); }) });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.phase).toBe('pip-install');
      expect(res.error).toBe(raw);
      expect(res.errorLan).toBe('The dependency install step (pip) failed. See the server log for details.');
      expect(res.errorLan).not.toMatch(NO_PATH);
    });

    it('keeps the npm step sentence path-free too', async () => {
      const steps = fakeSteps({
        npmCi: vi.fn(async () => { throw new Error('C:\\Program Files\\nodejs\\npm.cmd ci exited 1'); }),
      });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.phase).toBe('npm-ci');
      expect(res.error).toContain('npm.cmd');
      expect(res.errorLan).toBe('The dependency install step (npm) failed. See the server log for details.');
      expect(res.errorLan).not.toMatch(NO_PATH);
    });

    it('keeps a spawn ENOENT on the absolute interpreter path out of errorLan', async () => {
      const spawnErr = Object.assign(new Error('spawn /home/bob/castwright/venv/bin/python ENOENT'), {
        code: 'ENOENT',
        syscall: 'spawn /home/bob/castwright/venv/bin/python',
        path: '/home/bob/castwright/venv/bin/python',
      });
      const steps = fakeSteps({ pipInstall: vi.fn(async () => { throw spawnErr; }) });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.error).toContain('/home/bob');
      expect(res.errorLan).not.toMatch(NO_PATH);
    });

    it('keeps the ORT marker error (venv dir in its message) out of errorLan', async () => {
      const steps = fakeSteps({
        pipInstall: vi.fn(async () => { throw new Error('ORT marker: no site-packages under C:\\Users\\bob\\venv'); }),
      });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.errorLan).not.toMatch(NO_PATH);
    });

    it('needs-reinstall carries the same sentence in errorLan', async () => {
      const steps = fakeSteps({
        readStamp: vi.fn(() => ({ pythonTag: 'cp311', profile: 'nvidia', reqHash: 'x' })),
        resolveRequired: vi.fn(() => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'y' })),
      });
      const res = await applyUpgrade(ctx(), steps);
      expect(res.phase).toBe('needs-reinstall');
      expect(res.errorLan).toBe(res.error);
      expect(res.errorLan).toMatch(/reinstall/i);
    });
  });
});

describe('flipPointer (real, #4443 P5-1)', () => {
  it('replaces a read-only .current-version without deleting it first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'castwright-flip-'));
    try {
      const pointer = join(root, '.current-version');
      writeFileSync(pointer, '1.15.0');
      chmodSync(pointer, 0o444); // EPERM on win32 for a bare rename over it
      const steps = createApplySteps({ venvDir: join(root, 'venv'), log: () => {} });
      await steps.flipPointer(root, '1.16.0');
      expect(readFileSync(pointer, 'utf8')).toBe('1.16.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
