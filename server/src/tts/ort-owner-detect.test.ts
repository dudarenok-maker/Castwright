import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { detectOrtOwner } from '../../tts-sidecar/scripts/install-ort.mjs';

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

function venvWith(info: string | null, extra: string[] = []) {
  const root = mkTmp('sp-');
  const capi = join(root, 'onnxruntime', 'capi');
  mkdirSync(capi, { recursive: true });
  if (info !== null) writeFileSync(join(capi, 'build_and_package_info.py'), info);
  for (const f of extra) writeFileSync(join(capi, f), 'x');
  return root;
}

describe('detectOrtOwner', () => {
  it('reads the GPU wheel as a swap distribution', () => {
    const root = venvWith("package_name = 'onnxruntime-gpu'\n__version__ = '1.27.0'\n");
    expect(detectOrtOwner(root)).toBe('swap');
  });

  it('reads the CPU wheel as plain', () => {
    const root = venvWith("package_name = 'onnxruntime'\n__version__ = '1.28.0'\n");
    expect(detectOrtOwner(root)).toBe('plain');
  });

  it('falls back to the CUDA provider DLL when the info file is missing', () => {
    const root = venvWith(null, ['onnxruntime_providers_cuda.dll']);
    expect(detectOrtOwner(root)).toBe('swap');
  });

  it('reports plain when neither signal says GPU but the namespace exists', () => {
    const root = venvWith(null, ['_pybind_state.pyd']);
    expect(detectOrtOwner(root)).toBe('plain');
  });

  it('reports none for an ABSENT namespace — the interrupted-swap state', () => {
    const root = mkTmp('sp-');
    expect(detectOrtOwner(root)).toBe('none');
  });

  it('reports none for a gutted namespace (dir exists, capi empty)', () => {
    const root = mkTmp('sp-');
    mkdirSync(join(root, 'onnxruntime', 'capi'), { recursive: true });
    expect(detectOrtOwner(root)).toBe('none');
  });

  it('does not treat an unknown package name as a swap distribution', () => {
    const root = venvWith("package_name = 'onnxruntime-silly'\n");
    expect(detectOrtOwner(root)).toBe('plain');
  });
});
