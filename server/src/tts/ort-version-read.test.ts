import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { readInstalledOrtVersion } from '../../tts-sidecar/scripts/install-ort.mjs';

function distInfo(root: string, dirName: string, version: string) {
  const d = join(root, dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'METADATA'), `Metadata-Version: 2.1\nName: x\nVersion: ${version}\n`);
}

describe('readInstalledOrtVersion', () => {
  it('resolves the ESCAPED directory name from the bare package name', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    distInfo(root, 'onnxruntime_gpu-1.27.0.dist-info', '1.27.0');
    // The input is the bare name with a HYPHEN; the directory has an UNDERSCORE.
    expect(readInstalledOrtVersion(root, 'onnxruntime-gpu')).toBe('1.27.0');
  });

  it('returns null when absent', () => {
    expect(readInstalledOrtVersion(mkdtempSync(join(tmpdir(), 'sp-')), 'onnxruntime-gpu')).toBeNull();
  });

  it('returns null when AMBIGUOUS (a stale dist beside the current one)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    distInfo(root, 'onnxruntime_gpu-1.26.0.dist-info', '1.26.0');
    distInfo(root, 'onnxruntime_gpu-1.27.0.dist-info', '1.27.0');
    expect(readInstalledOrtVersion(root, 'onnxruntime-gpu')).toBeNull();
  });
});
