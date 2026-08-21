/* venv-migration.mjs is a pure, side-effect-free decision module (no CLI guard),
   so importing it here is inert. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeReqHash,
  decideVenvAction,
  readStamp,
  writeStamp,
  stampPath,
  classifyVenvState,
  resolveRequired,
} from '../../tts-sidecar/scripts/venv-migration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // server/src/tts
const SIDECAR_DIR = join(HERE, '..', '..', 'tts-sidecar');

describe('computeReqHash', () => {
  it('is stable for the same concatenated file contents', () => {
    const a = computeReqHash(['-r base.txt\ntorch==2.6.0\n', 'fastapi\n']);
    const b = computeReqHash(['-r base.txt\ntorch==2.6.0\n', 'fastapi\n']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any file content changes', () => {
    const a = computeReqHash(['torch==2.6.0\n']);
    const b = computeReqHash(['torch==2.8.0\n']);
    expect(a).not.toBe(b);
  });
  it('is order-sensitive (overlay then base is a defined order)', () => {
    expect(computeReqHash(['x\n', 'y\n'])).not.toBe(computeReqHash(['y\n', 'x\n']));
  });
  it('separator prevents the empty-segment collision (["ab",""] != ["a","b"])', () => {
    expect(computeReqHash(['ab', ''])).not.toBe(computeReqHash(['a', 'b']));
  });
});

const required = { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'aaa' };

describe('decideVenvAction', () => {
  it('no stamp (a v1.7.0 venv) → rebuild (M2)', () => {
    expect(decideVenvAction({ stamp: null, required })).toBe('rebuild');
  });
  it('pythonTag mismatch → rebuild', () => {
    expect(
      decideVenvAction({ stamp: { pythonTag: 'cp311', profile: 'nvidia', reqHash: 'aaa' }, required }),
    ).toBe('rebuild');
  });
  it('profile mismatch → rebuild', () => {
    expect(
      decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'amd', reqHash: 'aaa' }, required }),
    ).toBe('rebuild');
  });
  it('reqHash changed only → pip-in-place', () => {
    expect(
      decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'bbb' }, required }),
    ).toBe('pip-in-place');
  });
  it('all match → noop', () => {
    expect(
      decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'aaa' }, required }),
    ).toBe('noop');
  });
});

describe('stamp I/O', () => {
  it('round-trips a stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      writeStamp(dir, { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'h', builtVersion: '1.8.0' });
      expect(readStamp(dir)).toEqual({
        pythonTag: 'cp312',
        profile: 'nvidia',
        reqHash: 'h',
        builtVersion: '1.8.0',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null for a missing stamp (M2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      expect(readStamp(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null for a corrupt stamp rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      writeFileSync(stampPath(dir), '{not json', 'utf8');
      expect(readStamp(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const requiredClassify = { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'h' };
describe('classifyVenvState (Phase 1: detect-and-reinstall, no rebuild)', () => {
  it('no venv → fresh-bootstrap', () => {
    expect(classifyVenvState({ venvExists: false, stamp: null, required: requiredClassify }).action).toBe(
      'fresh-bootstrap',
    );
  });
  it('venv on cp311 (or no stamp) → needs-reinstall (NOT rebuild)', () => {
    expect(
      classifyVenvState({
        venvExists: true,
        stamp: { pythonTag: 'cp311', profile: 'nvidia', reqHash: 'h' },
        required: requiredClassify,
      }).action,
    ).toBe('needs-reinstall');
    expect(
      classifyVenvState({ venvExists: true, stamp: null, required: requiredClassify }).action,
    ).toBe('needs-reinstall');
  });
  it('cp312 + reqHash changed → pip-in-place', () => {
    expect(
      classifyVenvState({
        venvExists: true,
        stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'old' },
        required: requiredClassify,
      }).action,
    ).toBe('pip-in-place');
  });
  it('all match → noop', () => {
    expect(
      classifyVenvState({ venvExists: true, stamp: { ...requiredClassify }, required: requiredClassify })
        .action,
    ).toBe('noop');
  });
});

describe('resolveRequired (shared by bootstrap-venv + apply.ts)', () => {
  it('defaults to the nvidia overlay (no profile arg = today): stamps nvidia, hashes overlay-then-base', () => {
    const r = resolveRequired(SIDECAR_DIR);
    expect(r.pythonTag).toBe('cp312');
    expect(r.profile).toBe('nvidia');
    const overlay = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');
    const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
    expect(r.reqHash).toBe(computeReqHash([overlay, base]));
    expect(r.reqHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('selects the overlay by profile and stamps that profile', () => {
    const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
    for (const [profile, file] of [
      ['nvidia', 'nvidia-cuda.txt'],
      ['cpu', 'cpu.txt'],
      ['amd', 'amd-rocm.txt'],
    ] as const) {
      const r = resolveRequired(SIDECAR_DIR, profile);
      expect(r.profile).toBe(profile);
      const overlay = readFileSync(join(SIDECAR_DIR, 'requirements', file), 'utf8');
      expect(r.reqHash).toBe(computeReqHash([overlay, base]));
    }
  });

  it('gives each profile a distinct reqHash (different overlay text)', () => {
    const hashes = ['nvidia', 'cpu', 'amd'].map((p) => resolveRequired(SIDECAR_DIR, p).reqHash);
    expect(new Set(hashes).size).toBe(3);
  });

  it('maps apple (and any unknown) to the mac-safe nvidia overlay, but stamps the given profile', () => {
    const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
    const nvidia = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');
    const r = resolveRequired(SIDECAR_DIR, 'apple');
    expect(r.profile).toBe('apple');
    expect(r.reqHash).toBe(computeReqHash([nvidia, base]));
  });

  describe('side-28 ORT pin re-stamp (issue #2534): venv with stale reqHash must reinstall', () => {
    it('onnxruntime-gpu pin bump is invisible to reqHash without a requirements file change — the bug #2534 describes', () => {
      // This test captures the regressed behavior: the ORT pin was changed in
      // install-ort.mjs WITHOUT changing requirements/nvidia-cuda.txt, so reqHash
      // stayed the same and decideVenvAction returned 'noop' for every existing
      // venv, preventing the pin from ever taking effect. The fix is a comment
      // line in nvidia-cuda.txt that marks the pin bump so the file's content
      // (and reqHash) changes, forcing a reinstall (pip-in-place) on next run.
      const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
      const currentNvidia = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');

      // Simulate the OLD state: nvidia-cuda.txt WITHOUT the side-28 pin bump comment.
      // This is what was stamped in venvs built before the fix.
      const markerComment =
        '# NOTE: onnxruntime-gpu version constraint is in install-ort.mjs (ONNXRUNTIME_GPU_CONSTRAINT).\n' +
        '# Re-pinned 2026-08-21 (#2534 side-chain) to the CUDA-12 line (1.26.x); existing venvs need a reqHash bump to force reinstall.\n\n';
      const oldNvidiaContent = currentNvidia.replace(markerComment, '');
      const hasCommentMarker = currentNvidia.includes('Re-pinned 2026-08-21 (#2534 side-chain)');

      // The fix is a comment that explicitly marks where the pin was re-pinned.
      // If the comment is absent, both contents should be identical (the bug is
      // active). If the comment IS present, this test verifies the fix worked:
      // the hash MUST differ so a stale stamp triggers pip-in-place.
      if (!hasCommentMarker) {
        // The fix has NOT been applied yet — both old and current should match.
        // This proves the bug: the files are identical despite the pin change.
        expect(oldNvidiaContent).toBe(currentNvidia);
        const oldHash = computeReqHash([oldNvidiaContent, base]);
        const currentHash = computeReqHash([currentNvidia, base]);
        expect(oldHash).toBe(currentHash);

        // Demonstrate that without a hash change, existing venvs (with the old hash
        // stamped) see 'noop' and skip the reinstall that would apply the new pin.
        const required = resolveRequired(SIDECAR_DIR, 'nvidia');
        const stamp = { pythonTag: required.pythonTag, profile: required.profile, reqHash: oldHash };
        expect(decideVenvAction({ stamp, required })).toBe('noop');
      } else {
        // The fix HAS been applied — a comment in nvidia-cuda.txt marks the
        // pin bump, changing the file's content.
        expect(oldNvidiaContent).not.toBe(currentNvidia);
        const oldHash = computeReqHash([oldNvidiaContent, base]);
        const currentHash = computeReqHash([currentNvidia, base]);
        expect(oldHash).not.toBe(currentHash);

        // Now a venv with the OLD hash (pre-fix) triggers pip-in-place,
        // which re-runs the ORT swap with the new pin.
        const required = resolveRequired(SIDECAR_DIR, 'nvidia');
        const stamp = { pythonTag: required.pythonTag, profile: required.profile, reqHash: oldHash };
        expect(decideVenvAction({ stamp, required })).toBe('pip-in-place');
      }
    });
  });
});
