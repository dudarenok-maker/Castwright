import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // server/src/tts
const REQ = join(HERE, '..', '..', 'tts-sidecar', 'requirements');
const read = (f: string) => readFileSync(join(REQ, f), 'utf8');

describe('layered requirements (base + nvidia/cpu/amd overlays)', () => {
  it('every profile overlay -r includes base.txt', () => {
    for (const f of ['nvidia-cuda.txt', 'cpu.txt', 'amd-rocm.txt']) {
      expect(read(f)).toMatch(/^-r base\.txt/m);
    }
  });

  it('base.txt has vendor-neutral deps, no torch/onnxruntime', () => {
    const b = read('base.txt');
    expect(b).toMatch(/fastapi/);
    expect(b).toMatch(/faster-whisper/);
    expect(b).not.toMatch(/onnxruntime/);
    expect(b).not.toMatch(/^torch/m);
  });

  // Regression fence: the nvidia overlay == today's ACTUAL install. The [codec]
  // extra was dropped (commit b2a1ac19) — torchcodec only ships cores for FFmpeg
  // 4–7 and is only needed on torch >=2.9; we pin torch 2.8, so torchaudio keeps
  // in-core audio I/O and [codec] is unnecessary. torch/torchaudio are EXPLICIT
  // (coqui-tts 0.27.5 dropped the transitive torch dep). Kokoro is PLAIN (no [gpu]
  // extra): onnxruntime-gpu is installed by the nvidia ORT swap (install-ort.mjs),
  // not the overlay — so the [gpu] extra can't leave the CPU build owning the
  // shared onnxruntime/ namespace (the 2026-06-16 silent-CPU-Kokoro regression).
  it('nvidia overlay == TODAY: explicit pinned torch 2.8 + plain kokoro-onnx, NO [gpu]/[codec]', () => {
    const n = read('nvidia-cuda.txt');
    expect(n).toMatch(/^coqui-tts/m);
    expect(n).not.toMatch(/coqui-tts\[codec\]/);
    expect(n).toMatch(/^torch==2\.8\.0/m);
    expect(n).toMatch(/^torchaudio==2\.8\.0/m);
    expect(n).toMatch(/^kokoro-onnx\b/m);
    expect(n).not.toMatch(/^kokoro-onnx\[gpu\]/m); // anchored: a requirement line, not the explanatory comment
    expect(n).not.toMatch(/^onnxruntime-gpu/m); // swap-only; never in the shared overlay
  });

  it('requirements.txt shim points at the nvidia-cuda overlay (sole legacy default)', () => {
    const shim = readFileSync(join(REQ, '..', 'requirements.txt'), 'utf8');
    expect(shim).toMatch(/^-r requirements\/nvidia-cuda\.txt/m);
  });

  // cpu overlay: torch from PyPI (CUDA-bundled wheel runs on CPU; the cpu-index
  // lean build is pre-installed by install-torch when the profile is cpu), plain
  // kokoro-onnx + explicit onnxruntime (no [gpu] extra), no [codec].
  it('cpu overlay: pinned torch 2.8 + plain kokoro-onnx + onnxruntime, NO [gpu]/[codec]', () => {
    const c = read('cpu.txt');
    expect(c).toMatch(/^coqui-tts/m);
    expect(c).not.toMatch(/coqui-tts\[codec\]/);
    expect(c).not.toMatch(/^kokoro-onnx\[gpu\]/m);
    expect(c).toMatch(/^kokoro-onnx/m);
    expect(c).toMatch(/^onnxruntime\b/m);
    expect(c).toMatch(/^torch==2\.8\.0/m);
  });

  // amd overlay: torch (ROCm wheel) + onnxruntime-directml are installed SEPARATELY
  // by the resolver-driven installers (install-torch pre-installs the ROCm wheel
  // whose alpha local-version tag can't be pinned here; install-kokoro swaps in
  // onnxruntime-directml). So the overlay carries NO torch pin and plain
  // kokoro-onnx, and drops [codec] (torch 2.8 < 2.9, same as nvidia/cpu).
  it('amd overlay: plain coqui-tts + plain kokoro-onnx, NO torch pin / [gpu] / [codec]', () => {
    const a = read('amd-rocm.txt');
    expect(a).toMatch(/^coqui-tts/m);
    expect(a).not.toMatch(/coqui-tts\[codec\]/);
    expect(a).not.toMatch(/^kokoro-onnx\[gpu\]/m);
    expect(a).toMatch(/^kokoro-onnx/m);
    expect(a).not.toMatch(/^torch==/m); // torch is the ROCm wheel, pre-installed
  });
});
