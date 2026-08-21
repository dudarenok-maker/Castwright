import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { ensureOrtMarker, writeOrtMarker } from '../../tts-sidecar/scripts/install-ort.mjs';

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

function venv({ owner, realDist }: { owner: 'swap' | 'plain' | 'none'; realDist?: boolean }) {
  const root = mkTmp('venv-');
  const sp = join(root, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (owner !== 'none') {
    const capi = join(sp, 'onnxruntime', 'capi');
    mkdirSync(capi, { recursive: true });
    const name = owner === 'swap' ? 'onnxruntime-gpu' : 'onnxruntime';
    writeFileSync(join(capi, 'build_and_package_info.py'), `package_name = '${name}'\n`);
  }
  if (owner === 'swap') {
    const d = join(sp, 'onnxruntime_gpu-1.27.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime-gpu\nVersion: 1.27.0\n');
  }
  if (realDist) {
    const d = join(sp, 'onnxruntime-1.28.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.28.0\n');
    writeFileSync(join(d, 'INSTALLER'), 'pip\n');
    writeFileSync(join(d, 'RECORD'), 'onnxruntime/x,sha256=a,1\n');
  }
  return { root, sp };
}

describe('ensureOrtMarker', () => {
  it('writes a marker on a healthy GPU venv bootstrapped before this change', () => {
    const { root, sp } = venv({ owner: 'swap' });
    expect(ensureOrtMarker(root)).toBe('wrote');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('is idempotent — second run is a no-op', () => {
    const { root } = venv({ owner: 'swap' });
    ensureOrtMarker(root);
    expect(ensureOrtMarker(root)).toBe('noop');
  });

  it('REFUSES on a clobbered venv and names the remedy', () => {
    const { root, sp } = venv({ owner: 'swap', realDist: true });
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('clobbered');
    expect(existsSync(join(sp, 'onnxruntime-1.28.0.dist-info'))).toBe(true);
    const message = lines.join('\n');
    expect(message).toContain('install-ort.mjs');
    // The message must accurately describe the state: a stray plain dist-info coexists
    // with the GPU build's files (which own the namespace), NOT the other way around.
    expect(message).not.toContain('installed over the GPU runtime');
    expect(message).toContain('coexist');
  });

  it('deletes a lying marker when the CPU build owns the namespace', () => {
    const { root, sp } = venv({ owner: 'plain' });
    writeOrtMarker(sp, '1.27.0');
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
    const message = lines.join('\n');
    expect(message).toContain('[ort-marker]');
    expect(message).toContain('plain onnxruntime');
    expect(message).toContain('CPU build');
    expect(message).toContain('without GPU acceleration');
  });

  it('deletes a lying marker after an INTERRUPTED SWAP — no runtime at all', () => {
    const { root, sp } = venv({ owner: 'none' });
    writeOrtMarker(sp, '1.27.0');
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
    const message = lines.join('\n');
    expect(message).toContain('[ort-marker]');
    expect(message).toContain('No onnxruntime runtime is installed');
    expect(message).toContain('GPU Kokoro cannot load');
    expect(message).toContain('CASTWRIGHT_ACCELERATOR_PROFILE');
    expect(message).toContain('install-ort.mjs');
  });

  it('never throws on a venv that does not exist', () => {
    const gone = join(tmpdir(), 'definitely-not-a-venv-2192');
    rmSync(gone, { recursive: true, force: true });
    expect(() => ensureOrtMarker(gone)).not.toThrow();
    expect(ensureOrtMarker(gone)).toBe('noop');
  });

  it('never creates a site-packages tree on a half-built venv', () => {
    const root = mkTmp('venv-');
    ensureOrtMarker(root);
    expect(existsSync(join(root, 'Lib', 'site-packages'))).toBe(false);
  });

  it('never throws on a corrupted venv whose site-packages is a file, not a directory', () => {
    const root = mkTmp('venv-');
    mkdirSync(join(root, 'Lib'), { recursive: true });
    writeFileSync(join(root, 'Lib', 'site-packages'), 'not a directory');
    const lines: string[] = [];
    expect(() => ensureOrtMarker(root, (m: string) => lines.push(m))).not.toThrow();
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('noop');
    expect(lines.some((line) => line.includes('skipped') && line.includes('not a directory'))).toBe(true);
  });

  it('returns noop when no runtime exists and no marker is present (row 6)', () => {
    const { root } = venv({ owner: 'none' });
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('noop');
    expect(lines.length).toBe(0);
  });

  it.each([
    {
      name: 'clobbered branch',
      setup: () => venv({ owner: 'swap', realDist: true }),
      expectedReturn: 'clobbered',
      verify: (_sp: string) => undefined, // State already verified by the test framework
    },
    {
      name: 'deletion branch for plain onnxruntime',
      setup: () => {
        const { root, sp } = venv({ owner: 'plain' });
        writeOrtMarker(sp, '1.27.0');
        return { root, sp };
      },
      expectedReturn: 'deleted',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
      },
    },
    {
      name: 'deletion branch for no runtime (interrupted swap)',
      setup: () => {
        const { root, sp } = venv({ owner: 'none' });
        writeOrtMarker(sp, '1.27.0');
        return { root, sp };
      },
      expectedReturn: 'deleted',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
      },
    },
  ])('never throws even when the caller-supplied log itself throws ($name)', ({ setup, expectedReturn, verify }) => {
    // The safeLog wrapper inside ensureOrtMarker must catch and swallow throwing
    // logs at every call site — including the clobbered, plain-deletion, and
    // none-deletion branches. A throwing log must not defeat the "never throws"
    // guarantee that ensureOrtMarker's callers (server startup) depend on.
    const { root, sp } = setup();
    const throwingLog = () => {
      throw new Error('log sink is down');
    };
    let result;
    expect(() => {
      result = ensureOrtMarker(root, throwingLog);
    }).not.toThrow();
    expect(result).toBe(expectedReturn);
    verify(sp);
  });
});
