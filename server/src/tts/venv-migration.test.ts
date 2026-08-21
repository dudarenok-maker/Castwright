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

  it('requirements/*.txt files never contain CRLF on disk, so reqHash is checkout-independent (#2586)', () => {
    // resolveRequired() hashes these files' RAW bytes (no normalization), and reqHash is
    // persisted to the venv stamp and compared across checkouts/machines (e.g. a Windows dev
    // box vs. the ubuntu-latest release build). A core.autocrlf=true (default Git-for-Windows)
    // checkout materialises `* text=auto` files as CRLF, so without an explicit LF pin the same
    // requirements content hashes differently depending on who cloned it, producing a spurious
    // 'pip-in-place' migration for every existing venv (#2586). `.gitattributes` pins
    // `server/tts-sidecar/requirements/*.txt` to `text eol=lf` to close that off; this asserts
    // the pin is actually in effect on disk, independent of any single box's `core.autocrlf`.
    for (const file of ['base.txt', 'nvidia-cuda.txt', 'cpu.txt', 'amd-rocm.txt']) {
      const raw = readFileSync(join(SIDECAR_DIR, 'requirements', file));
      expect(raw.includes(0x0d), `${file} contains a CR byte (CRLF line ending)`).toBe(false);
    }
  });

  it('maps apple (and any unknown) to the mac-safe nvidia overlay, but stamps the given profile', () => {
    const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
    const nvidia = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');
    const r = resolveRequired(SIDECAR_DIR, 'apple');
    expect(r.profile).toBe('apple');
    expect(r.reqHash).toBe(computeReqHash([nvidia, base]));
  });

  describe('side-28 ORT pin re-stamp (issue #2534): venv with stale reqHash must reinstall', () => {
    it('onnxruntime-gpu pin bump must be coupled to reqHash via requirements text change', async () => {
      // Regression test for #2534: the ORT pin was changed in install-ort.mjs WITHOUT
      // changing requirements/nvidia-cuda.txt, so reqHash stayed the same and
      // decideVenvAction returned 'noop' for every existing venv, preventing the pin
      // from ever taking effect. This test ties the on-disk constraint to the actual
      // planner output, so a future pin bump CANNOT be committed without touching
      // nvidia-cuda.txt's hashed text.

      // @ts-expect-error — standalone install script ships no .d.ts.
      const { planOrtSwap } = await import('../../tts-sidecar/scripts/install-ort.mjs');

      const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
      const currentNvidia = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');
      // Normalize line endings for the marker-finding string ops below (indexOf/substring),
      // which are line-ending sensitive. This is NOT what keeps the hash comparisons in this
      // test correct across checkouts — that's guaranteed by .gitattributes pinning
      // requirements/*.txt to LF, so production's raw-byte reqHash (via resolveRequired,
      // read without normalization) is identical regardless of the checking-out box's
      // core.autocrlf setting (#2586).
      const normalizedBase = base.replace(/\r\n/g, '\n');
      const normalizedNvidia = currentNvidia.replace(/\r\n/g, '\n');

      // Read the CURRENT constraint directly from the planner, not as a hand-typed literal.
      // This forces any future pin bump in install-ort.mjs to update nvidia-cuda.txt,
      // because the test will fail if the constraint string isn't present in the file.
      const plan = planOrtSwap('nvidia', 'win32');
      expect(plan.action).toBe('swap');
      expect(plan.ortPackage).toBe('onnxruntime-gpu');

      // Extract the version constraint from the install step. The format is
      // 'onnxruntime-gpu>=X.Y,<X.Z'. Extract just the version numbers (e.g., "1.26" and "1.27").
      const installStep = plan.steps[1];
      expect(installStep[0]).toBe('install');
      const packageSpec = installStep[installStep.length - 1]; // last arg is the package spec
      expect(packageSpec).toMatch(/^onnxruntime-gpu>=[\d.]+,<[\d.]+$/);

      // Extract version numbers from the constraint: >=1.26,<1.27 -> extract "1.26" and "1.27"
      const versionMatch = packageSpec.match(/>=([^,]+),<(.+)$/);
      expect(versionMatch).not.toBeNull();
      const [, minVersion, maxVersion] = versionMatch!;

      // ORACLE 1: BOTH the floor AND cap version numbers from the constraint MUST be present in nvidia-cuda.txt.
      // This ensures that if install-ort.mjs's ONNXRUNTIME_GPU_CONSTRAINT changes (floor, cap, or both),
      // the file's content must change too, triggering a reqHash bump. Using || would miss a cap-only
      // widening (e.g., >=1.26,<1.28 instead of >=1.26,<1.27), so && is required to catch all changes.
      const hasVersionMarker = normalizedNvidia.includes(minVersion) && normalizedNvidia.includes(maxVersion);
      expect(hasVersionMarker).toBe(true);

      // ORACLE 2: Simulate a pre-fix venv (old state WITHOUT the marker comment).
      // The marker spans two lines; remove both to simulate the bug state.
      const markerStart = normalizedNvidia.indexOf('# NOTE: onnxruntime-gpu version constraint');
      expect(markerStart).toBeGreaterThanOrEqual(0);

      // Find the end of the marker block (the blank line after the second comment).
      const markerEnd = normalizedNvidia.indexOf('\n\n', markerStart);
      expect(markerEnd).toBeGreaterThanOrEqual(markerStart);

      const oldNvidiaContent =
        normalizedNvidia.substring(0, markerStart) +
        normalizedNvidia.substring(markerEnd + 2); // +2 to skip the \n\n

      // Verify the marker removal actually changed the content.
      expect(oldNvidiaContent).not.toEqual(normalizedNvidia);

      const oldHash = computeReqHash([oldNvidiaContent, normalizedBase]);
      const currentHash = computeReqHash([normalizedNvidia, normalizedBase]);

      // ORACLE 3: The hashes MUST differ (the marker comment must affect the hash).
      expect(oldHash).not.toBe(currentHash);

      // ORACLE 4: A venv with the old hash (pre-fix) MUST trigger pip-in-place,
      // which re-runs the ORT swap with the new pin.
      const required = resolveRequired(SIDECAR_DIR, 'nvidia');
      const staleStamp = { pythonTag: required.pythonTag, profile: required.profile, reqHash: oldHash };
      expect(decideVenvAction({ stamp: staleStamp, required })).toBe('pip-in-place');

      // ORACLE 5: A venv with the CURRENT hash should see 'noop' (no action needed).
      const freshStamp = { pythonTag: required.pythonTag, profile: required.profile, reqHash: currentHash };
      expect(decideVenvAction({ stamp: freshStamp, required })).toBe('noop');
    });
  });
});
