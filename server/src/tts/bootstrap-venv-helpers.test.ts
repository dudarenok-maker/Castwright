/* fs-21 — bootstrap-venv.mjs helpers. The script's main() is
   guarded (runs only when invoked directly), so importing it here is inert. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  venvPythonPath,
  venvAlreadyBootstrapped,
  installForProfile,
  // @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
} from '../../tts-sidecar/scripts/bootstrap-venv.mjs';

/** A fake `runPip` that records every pip arg list and fails the calls whose
    joined args match any `failOn` substring. */
function fakePip(failOn: string[] = []) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return !failOn.some((f) => args.join(' ').includes(f));
  };
  return { run, calls };
}

describe('bootstrap-venv helpers', () => {
  it('venvPythonPath: win32 → Scripts/python.exe, posix → bin/python', () => {
    expect(venvPythonPath('/v', 'win32')).toBe(join('/v', 'Scripts', 'python.exe'));
    expect(venvPythonPath('/v', 'linux')).toBe(join('/v', 'bin', 'python'));
  });
  it('venvAlreadyBootstrapped reflects the python binary presence', () => {
    const d = mkdtempSync(join(tmpdir(), 'v-'));
    expect(venvAlreadyBootstrapped(d, 'linux')).toBe(false);
    mkdirSync(join(d, 'bin'), { recursive: true });
    writeFileSync(join(d, 'bin', 'python'), '');
    expect(venvAlreadyBootstrapped(d, 'linux')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('installForProfile — Auto + CPU fallback (AMD phase 2)', () => {
  it('nvidia installs its overlay then swaps onnxruntime → onnxruntime-gpu', () => {
    const pip = fakePip();
    expect(installForProfile('/py', 'nvidia', pip.run, 'win32', null)).toBe('nvidia');
    const joined = pip.calls.map((c) => c.join(' '));
    // overlay first (pulls plain onnxruntime via kokoro-onnx), then the GPU swap —
    // so onnxruntime-gpu unambiguously owns the shared onnxruntime/ namespace.
    expect(joined[0]).toMatch(/install -r .*nvidia-cuda\.txt/);
    expect(joined[1]).toBe('uninstall -y onnxruntime');
    expect(joined[2]).toBe('install onnxruntime-gpu');
    expect(pip.calls).toHaveLength(3);
  });

  it('nvidia: a failed ORT swap is fatal (no silent CPU-only Kokoro)', () => {
    const pip = fakePip(['onnxruntime-gpu']); // the GPU install step fails
    expect(() => installForProfile('/py', 'nvidia', pip.run, 'win32', null)).toThrow(
      /ONNX runtime swap failed/,
    );
  });

  it('amd success: pre-installs ROCm wheels + amd overlay, returns amd', () => {
    const pip = fakePip();
    expect(installForProfile('/py', 'amd', pip.run, 'win32', null)).toBe('amd');
    const joined = pip.calls.map((c) => c.join(' '));
    expect(joined[0]).toMatch(/install --no-cache-dir .*torch-2\.8\.0a0.*\.whl/); // ROCm wheels
    expect(joined.some((c) => /install -r .*amd-rocm\.txt/.test(c))).toBe(true);
  });

  it('amd ROCm wheel failure → falls back to a CPU install (returns cpu + marker)', () => {
    const d = mkdtempSync(join(tmpdir(), 'venv-'));
    try {
      const pip = fakePip(['torch-2.8.0a0']); // the ROCm wheel install fails
      expect(installForProfile('/py', 'amd', pip.run, 'win32', d)).toBe('cpu');
      const joined = pip.calls.map((c) => c.join(' '));
      // fell back to the cpu overlay, and never installed the amd overlay
      expect(joined.some((c) => /install -r .*cpu\.txt/.test(c))).toBe(true);
      expect(joined.some((c) => /amd-rocm\.txt/.test(c))).toBe(false);
      // and recorded the fallback marker for the runtime/UI to surface
      expect(existsSync(join(d, '.accelerator-fallback.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(d, '.accelerator-fallback.json'), 'utf8'))).toEqual({
        requested: 'amd',
        effective: 'cpu',
        reason: 'rocm-install-failed',
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('amd overlay failure (after torch ok) also falls back to cpu', () => {
    const pip = fakePip(['amd-rocm.txt']);
    expect(installForProfile('/py', 'amd', pip.run, 'win32', null)).toBe('cpu');
    expect(pip.calls.map((c) => c.join(' ')).some((c) => /cpu\.txt/.test(c))).toBe(true);
  });

  it('throws when even the CPU fallback install fails (genuinely fatal)', () => {
    const pip = fakePip(['torch-2.8.0a0', 'cpu.txt']); // ROCm + cpu both fail
    expect(() => installForProfile('/py', 'amd', pip.run, 'win32', null)).toThrow(/CPU fallback/);
  });
});
