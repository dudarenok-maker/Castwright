/* restoreOrtRuntime (#2192 / #3039) — the post-install ONNX-runtime restore
   the in-app Qwen installer runs. Real install-ort.mjs helpers against a
   throwaway fake site-packages; only `runPip` is a fake. Pins the three-part
   marker invariant (delete first / delete-on-failure / write last), the
   healthy-venv skip, and that pip is awaited (async), never assumed. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restoreOrtRuntime } from './ort-restore.js';
// @ts-expect-error — plain-JS install script, no .d.ts.
import { writeOrtMarker, isOurMarker } from '../../tts-sidecar/scripts/install-ort.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A venv whose site-packages is owned by `owner`: 'swap' = onnxruntime-gpu's
    files + dist-info, 'plain' = the CPU build's files + dist-info. */
function fakeVenv(owner: 'swap' | 'plain' | 'none'): { venvDir: string; sp: string } {
  const venvDir = mkdtempSync(join(tmpdir(), 'ort-restore-'));
  roots.push(venvDir);
  const sp = join(venvDir, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (owner === 'none') return { venvDir, sp };
  const capi = join(sp, 'onnxruntime', 'capi');
  mkdirSync(capi, { recursive: true });
  const pkg = owner === 'swap' ? 'onnxruntime-gpu' : 'onnxruntime';
  writeFileSync(join(capi, 'build_and_package_info.py'), `package_name = '${pkg}'\n`);
  const distInfo = owner === 'swap' ? 'onnxruntime_gpu-1.26.0.dist-info' : 'onnxruntime-1.29.0.dist-info';
  mkdirSync(join(sp, distInfo));
  writeFileSync(join(sp, distInfo, 'METADATA'), `Name: ${pkg}\nVersion: ${owner === 'swap' ? '1.26.0' : '1.29.0'}\n`);
  writeFileSync(join(sp, distInfo, 'INSTALLER'), 'pip\n');
  writeFileSync(join(sp, distInfo, 'RECORD'), 'x\n');
  return { venvDir, sp };
}

function markerDirs(sp: string): string[] {
  return readdirSync(sp).filter((d) => /^onnxruntime-\d.*\.dist-info$/.test(d) && isOurMarker(join(sp, d)));
}

describe('restoreOrtRuntime', () => {
  it('cpu profile: no pip, removes any marker of ours, reports not-needed', async () => {
    const { venvDir, sp } = fakeVenv('plain');
    writeOrtMarker(sp, '1.26.0'); // a stale marker from an earlier life
    expect(markerDirs(sp)).toHaveLength(1);
    const pip: string[][] = [];
    const outcome = await restoreOrtRuntime({
      venvDir, profile: 'cpu', platform: 'win32',
      runPip: async (a) => { pip.push([...a]); },
    });
    expect(outcome).toBe('not-needed');
    expect(pip).toEqual([]);
    expect(markerDirs(sp)).toHaveLength(0);
  });

  it('nvidia profile, GPU build already owns the namespace: no pip, marker re-certified, already-in-place', async () => {
    const { venvDir, sp } = fakeVenv('swap');
    const pip: string[][] = [];
    const outcome = await restoreOrtRuntime({
      venvDir, profile: 'nvidia', platform: 'win32',
      runPip: async (a) => { pip.push([...a]); },
    });
    expect(outcome).toBe('already-in-place');
    expect(pip).toEqual([]);
    // ensureOrtMarker wrote the marker for the installed GPU version.
    expect(markerDirs(sp)).toEqual(['onnxruntime-1.26.0.dist-info']);
  });

  it('nvidia profile, plain build clobbered the namespace: marker deleted BEFORE the first pip step, steps awaited in order, marker written LAST', async () => {
    const { venvDir, sp } = fakeVenv('plain');
    writeOrtMarker(sp, '1.26.0'); // certifies a swap that pip just undid
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runPip = async (a: readonly string[]) => {
      seen.push(`pip ${a[0]} marker=${markerDirs(sp).length}`);
      if (a[0] === 'uninstall') await gate; // hold the FIRST step open
      if (a[0] === 'install' && a.includes('--force-reinstall')) {
        // Simulate the GPU wheel landing: the namespace flips to the swap build.
        rmSync(join(sp, 'onnxruntime-1.29.0.dist-info'), { recursive: true, force: true });
        writeFileSync(join(sp, 'onnxruntime', 'capi', 'build_and_package_info.py'), "package_name = 'onnxruntime-gpu'\n");
        mkdirSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info'));
        writeFileSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info', 'METADATA'), 'Name: onnxruntime-gpu\nVersion: 1.26.0\n');
      }
    };
    const pending = restoreOrtRuntime({ venvDir, profile: 'nvidia', platform: 'win32', runPip });
    // While the first pip step is still running, nothing further has happened:
    // the restore is genuinely awaiting the subprocess, not racing past it.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['pip uninstall marker=0']);
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe('swapped');
    expect(seen).toEqual(['pip uninstall marker=0', 'pip install marker=0', 'pip install marker=0']);
    expect(markerDirs(sp)).toEqual(['onnxruntime-1.26.0.dist-info']);
  });

  it('a failing pip step rethrows and leaves NO marker behind', async () => {
    const { venvDir, sp } = fakeVenv('plain');
    writeOrtMarker(sp, '1.26.0');
    const runPip = async (a: readonly string[]) => {
      if (a[0] === 'install') throw new Error('pip install onnxruntime-gpu exited with code 1. network down');
    };
    await expect(
      restoreOrtRuntime({ venvDir, profile: 'nvidia', platform: 'win32', runPip }),
    ).rejects.toThrow(/network down/);
    expect(markerDirs(sp)).toHaveLength(0);
  });

  it('nvidia profile, no onnxruntime at all: swaps (the healthy skip needs the GPU build to own the namespace)', async () => {
    const { venvDir, sp } = fakeVenv('none');
    const pip: string[][] = [];
    const runPip = async (a: readonly string[]) => {
      pip.push([...a]);
      if (a.includes('--force-reinstall')) {
        mkdirSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info'));
        writeFileSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info', 'METADATA'), 'Version: 1.26.0\n');
      }
    };
    expect(await restoreOrtRuntime({ venvDir, profile: 'nvidia', platform: 'win32', runPip })).toBe('swapped');
    expect(pip.map((a) => a[0])).toEqual(['uninstall', 'install', 'install']);
    expect(existsSync(join(sp, 'onnxruntime-1.26.0.dist-info'))).toBe(true);
  });
});
