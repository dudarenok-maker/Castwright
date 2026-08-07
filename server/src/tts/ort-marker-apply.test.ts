import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOrtMarkerWrite, applyOrtMarkerDelete, planOrtSwap, writeOrtMarker,
} from '../../tts-sidecar/scripts/install-ort.mjs';

function venv(withGpuDist = false) {
  const root = mkdtempSync(join(tmpdir(), 'venv-'));
  const sp = join(root, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (withGpuDist) {
    const d = join(sp, 'onnxruntime_gpu-1.27.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime-gpu\nVersion: 1.27.0\n');
  }
  return { root, sp };
}

describe('applyOrtMarkerWrite', () => {
  it('writes the marker at the INSTALLED version', () => {
    const { root, sp } = venv(true);
    applyOrtMarkerWrite(root, planOrtSwap('nvidia', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('is a NO-OP when the plan says delete — a write on cpu has no ortPackage', () => {
    const { root, sp } = venv();
    applyOrtMarkerWrite(root, planOrtSwap('cpu', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('THROWS when the version cannot be read — never writes a guessed version', () => {
    const { root } = venv(false);
    expect(() => applyOrtMarkerWrite(root, planOrtSwap('nvidia', 'win32'))).toThrow(/version/i);
  });
});

describe('applyOrtMarkerDelete', () => {
  it('removes our marker on a delete plan', () => {
    const { root, sp } = venv();
    writeOrtMarker(sp, '1.27.0');
    applyOrtMarkerDelete(root, planOrtSwap('cpu', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('also removes it on a SWAP plan — the failure path calls this before rethrowing', () => {
    const { root, sp } = venv(true);
    writeOrtMarker(sp, '1.27.0');
    applyOrtMarkerDelete(root, planOrtSwap('nvidia', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('never throws on a venv with no site-packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    expect(() => applyOrtMarkerDelete(root, planOrtSwap('cpu', 'win32'))).not.toThrow();
  });
});
