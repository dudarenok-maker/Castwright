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

  // Re-tier: Qwen is now standard on GPU profiles (nvidia/amd); Coqui is opt-in
  // (removed from the overlay, installed on demand from the Model Manager). Kokoro
  // is PLAIN (no [gpu] extra): onnxruntime-gpu is installed by the nvidia ORT swap
  // (install-ort.mjs), not the overlay — preserving the 2026-06-16 fix.
  it('nvidia overlay: qwen-tts standard, coqui-tts opt-in, pinned torch 2.8 + plain kokoro-onnx', () => {
    const n = read('nvidia-cuda.txt');
    expect(n).not.toMatch(/^coqui-tts/m);   // re-tiered: Coqui is opt-in now
    expect(n).toMatch(/^qwen-tts\b/m);      // Qwen is standard on GPU profiles
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

  // Re-tier: cpu overlay drops Coqui (opt-in); Qwen is GPU-only standard so it is
  // absent here too. Kokoro + torch remain; plain kokoro-onnx + explicit onnxruntime
  // (no [gpu] extra), no [codec].
  it('cpu overlay: coqui-tts opt-in (absent), qwen-tts GPU-only (absent), pinned torch 2.8 + plain kokoro-onnx', () => {
    const c = read('cpu.txt');
    expect(c).not.toMatch(/^coqui-tts/m);   // opt-in
    expect(c).not.toMatch(/^qwen-tts\b/m);  // Qwen is GPU-only standard
    expect(c).not.toMatch(/^kokoro-onnx\[gpu\]/m);
    expect(c).toMatch(/^kokoro-onnx/m);
    expect(c).toMatch(/^onnxruntime\b/m);
    expect(c).toMatch(/^torch==2\.8\.0/m);
  });

  // Re-tier: amd overlay drops Coqui (opt-in) and adds qwen-tts (standard on GPU
  // profiles). torch (ROCm wheel) is pre-installed separately; plain kokoro-onnx,
  // no [codec], no torch pin.
  it('amd overlay: qwen-tts standard, coqui-tts opt-in (absent), plain kokoro-onnx, NO torch pin / [gpu]', () => {
    const a = read('amd-rocm.txt');
    expect(a).not.toMatch(/^coqui-tts/m);
    expect(a).toMatch(/^qwen-tts\b/m);
    expect(a).not.toMatch(/^kokoro-onnx\[gpu\]/m);
    expect(a).toMatch(/^kokoro-onnx/m);
    expect(a).not.toMatch(/^torch==/m); // torch is the ROCm wheel, pre-installed
  });
});
