import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { SWAP_ORT_PACKAGES, escapeDistName, sitePackagesDir } from '../../tts-sidecar/scripts/install-ort.mjs';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe('escapeDistName', () => {
  it('escapes per PEP 427 so the glob matches the real directory', () => {
    // pip writes onnxruntime_gpu-1.27.0.dist-info — underscore, not hyphen.
    expect(escapeDistName('onnxruntime-gpu')).toBe('onnxruntime_gpu');
    expect(escapeDistName('onnxruntime-directml')).toBe('onnxruntime_directml');
    expect(escapeDistName('onnxruntime')).toBe('onnxruntime');
  });

  it('collapses dots to a single underscore, per PEP 427', () => {
    expect(escapeDistName('a.b')).toBe('a_b');
  });

  it('collapses a RUN of separators (-, _, .) to a single underscore', () => {
    expect(escapeDistName('a--b')).toBe('a_b');
  });
});

describe('SWAP_ORT_PACKAGES', () => {
  it('is derived from installRecipe, not hand-typed', () => {
    expect(SWAP_ORT_PACKAGES).toContain('onnxruntime-gpu');
    expect(SWAP_ORT_PACKAGES).not.toContain('onnxruntime');
  });
});

describe('sitePackagesDir', () => {
  it('finds the Windows layout', () => {
    const venv = mkTmp('venv-');
    mkdirSync(join(venv, 'Lib', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBe(join(venv, 'Lib', 'site-packages'));
  });

  it('finds the posix layout without needing the minor version', () => {
    const venv = mkTmp('venv-');
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBe(join(venv, 'lib', 'python3.12', 'site-packages'));
  });

  it('returns null on a venv with no site-packages (half-built box)', () => {
    const venv = mkTmp('venv-');
    expect(sitePackagesDir(venv)).toBeNull();
  });

  it('returns null when the posix layout is ambiguous', () => {
    const venv = mkTmp('venv-');
    mkdirSync(join(venv, 'lib', 'python3.11', 'site-packages'), { recursive: true });
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBeNull();
  });
});
