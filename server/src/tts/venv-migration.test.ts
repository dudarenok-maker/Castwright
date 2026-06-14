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
  it('reads the canonical python tag, stamps the effective nvidia profile, and hashes overlay-then-base', () => {
    const r = resolveRequired(SIDECAR_DIR);
    expect(r.pythonTag).toBe('cp312');
    expect(r.profile).toBe('nvidia');
    const overlay = readFileSync(join(SIDECAR_DIR, 'requirements', 'nvidia-cuda.txt'), 'utf8');
    const base = readFileSync(join(SIDECAR_DIR, 'requirements', 'base.txt'), 'utf8');
    expect(r.reqHash).toBe(computeReqHash([overlay, base]));
    expect(r.reqHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
