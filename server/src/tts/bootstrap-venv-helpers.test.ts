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
  it('nvidia pre-installs cu128 torch, then the overlay, then swaps onnxruntime → onnxruntime-gpu', () => {
    const pip = fakePip();
    expect(installForProfile('/py', 'nvidia', pip.run, 'win32', null)).toBe('nvidia');
    const joined = pip.calls.map((c) => c.join(' '));
    // cu128 torch FIRST (PyPI default torch is CPU-only on Windows) — the exact
    // pins are read from the overlay, so the overlay's torch==X is then satisfied.
    expect(joined[0]).toMatch(
      /^install torch==\S+ torchaudio==\S+ --index-url https:\/\/download\.pytorch\.org\/whl\/cu128$/,
    );
    // overlay next (pulls plain onnxruntime via kokoro-onnx), then the GPU swap —
    // so onnxruntime-gpu unambiguously owns the shared onnxruntime/ namespace.
    expect(joined[1]).toMatch(/install -r .*nvidia-cuda\.txt/);
    expect(joined[2]).toBe('uninstall -y onnxruntime onnxruntime-gpu');
    // side-28: the install step now carries an explicit version constraint (see
    // install-ort.mjs's ONNXRUNTIME_GPU_CONSTRAINT) so the runtime isn't whatever
    // happened to be latest on PyPI on install date.
    expect(joined[3]).toBe('install --force-reinstall --no-deps onnxruntime-gpu>=1.26,<1.27');
    // #2600: a final, separate cuDNN(+cublas+cufft+cuda-runtime) install —
    // deliberately WITHOUT --no-deps (see install-ort.mjs's extraRuntimeSteps)
    // so onnxruntime-gpu's CUDAExecutionProvider can actually construct an
    // InferenceSession instead of silently falling back to CPU. cublas is
    // pinned alongside cuDNN (review finding M2) rather than left to resolve
    // unpinned. Pass 2 review (N4/N6, PR #2617): cublas is `~=12.8.0`, not
    // `~=12.9` — floor-plus-cap on the 12.8.x line torch cu128 bundles,
    // matching install-ort.mjs's own corrected comment — and nvrtc is
    // dropped entirely (onnxruntime's own DLL list never looks for it on
    // Windows). cuDNN tightened to `~=9.19.0` and cufft/cuda-runtime added
    // 2026-08-31 (register row A28, discharged/on-box confirmed) — see
    // install-ort.mjs's own comment on NVIDIA_CUDNN_CONSTRAINT for the real
    // torch-breaking regression an unpinned `~=9.0` caused on real hardware.
    expect(joined[4]).toBe(
      'install nvidia-cudnn-cu12~=9.19.0 nvidia-cublas-cu12~=12.8.0 nvidia-cufft-cu12~=11.3.3 nvidia-cuda-runtime-cu12~=12.8.0',
    );
    expect(pip.calls).toHaveLength(5);
  });

  it('nvidia: a failed ORT swap is fatal (no silent CPU-only Kokoro)', () => {
    const pip = fakePip(['onnxruntime-gpu']); // the GPU install step fails
    expect(() => installForProfile('/py', 'nvidia', pip.run, 'win32', null)).toThrow(
      /ONNX runtime swap failed/,
    );
  });

  it('nvidia: a failed cuDNN step (extraRuntimeSteps, #2600) is ALSO fatal, and named correctly', () => {
    // Review finding M3: the prior "a failed ORT swap is fatal" test above
    // trips at the UNINSTALL step (joined[2]) and never reaches the cuDNN
    // install — so a failure of THIS step specifically (by far the largest
    // and most network-fragile of the five pip calls, #2600) was never
    // exercised. Without this coverage a broken/network-failed cuDNN install
    // could silently succeed the overall bootstrap and leave Kokoro on CPU
    // with no error raised anywhere.
    //
    // Pass 3 review finding N8 (PR #2617): this step's own failure used to be
    // reported as "ONNX runtime swap failed" too — the same headline the
    // uninstall/reinstall steps use — which names the wrong step for what is
    // now the largest, most network-fragile pip call in the loop. It must be
    // named distinctly.
    const pip = fakePip(['nvidia-cudnn-cu12']); // only the cuDNN step fails
    expect(() => installForProfile('/py', 'nvidia', pip.run, 'win32', null)).toThrow(
      /cuDNN\/cublas runtime install failed/,
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

describe('installForProfile ORT marker wiring', () => {
  function harness(profile: string, { failSwap = false } = {}) {
    const calls: string[] = [];
    const runPip = (args: string[]) => {
      calls.push(`pip ${args.join(' ')}`);
      if (failSwap && args[0] === 'install' && args.includes('--force-reinstall')) return false;
      return true;
    };
    const marker = {
      del: () => { calls.push('marker:delete'); },
      write: () => { calls.push('marker:write'); },
    };
    return { calls, runPip, marker, profile };
  }

  it('deletes the marker BEFORE any overlay install', () => {
    const h = harness('cpu');
    installForProfile('py', 'cpu', h.runPip, 'win32', '/venv', h.marker);
    const delIdx = h.calls.indexOf('marker:delete');
    const firstPip = h.calls.findIndex((c) => c.startsWith('pip install -r'));
    expect(delIdx).toBeGreaterThanOrEqual(0); // positive control: the delete actually happened
    expect(firstPip).toBeGreaterThanOrEqual(0); // positive control: an overlay install actually happened
    expect(delIdx).toBeLessThan(firstPip);
  });

  it('writes the marker only after a successful nvidia swap', () => {
    const h = harness('nvidia');
    installForProfile('py', 'nvidia', h.runPip, 'win32', '/venv', h.marker);
    const swapIdx = h.calls.findIndex((c) => c.includes('--force-reinstall'));
    const writeIdx = h.calls.indexOf('marker:write');
    expect(swapIdx).toBeGreaterThanOrEqual(0); // positive control: the swap step actually ran
    expect(writeIdx).toBeGreaterThanOrEqual(0); // positive control: the write actually happened
    expect(writeIdx).toBeGreaterThan(swapIdx);
  });

  it('never writes on cpu', () => {
    const h = harness('cpu');
    installForProfile('py', 'cpu', h.runPip, 'win32', '/venv', h.marker);
    expect(h.calls).toContain('marker:delete'); // positive control: the seam IS wired on cpu
    expect(h.calls).not.toContain('marker:write'); // and it correctly does not write
  });

  it('deletes the marker when the swap FAILS, before rethrowing', () => {
    const h = harness('nvidia', { failSwap: true });
    expect(() => installForProfile('py', 'nvidia', h.runPip, 'win32', '/venv', h.marker)).toThrow();
    // one delete at entry, one on the failure path
    expect(h.calls.filter((c) => c === 'marker:delete')).toHaveLength(2);
    expect(h.calls).not.toContain('marker:write');
  });
});
