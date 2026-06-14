import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // server/src/tts
const REQ = join(HERE, '..', '..', 'tts-sidecar', 'requirements');

describe('layered requirements (Phase 1: base + nvidia-cuda only)', () => {
  it('nvidia-cuda overlay -r base.txt', () => {
    expect(readFileSync(join(REQ, 'nvidia-cuda.txt'), 'utf8')).toMatch(/^-r base\.txt/m);
  });
  it('base.txt has vendor-neutral deps, no torch/onnxruntime', () => {
    const b = readFileSync(join(REQ, 'base.txt'), 'utf8');
    expect(b).toMatch(/fastapi/);
    expect(b).toMatch(/faster-whisper/);
    expect(b).not.toMatch(/onnxruntime/);
    expect(b).not.toMatch(/^torch/m);
  });
  it('nvidia overlay == TODAY: coqui-tts[codec] + kokoro-onnx[gpu] (regression fence)', () => {
    const n = readFileSync(join(REQ, 'nvidia-cuda.txt'), 'utf8');
    expect(n).toMatch(/coqui-tts\[codec\]/);
    expect(n).toMatch(/kokoro-onnx\[gpu\]/);
  });
  it('requirements.txt shim points at the nvidia-cuda overlay (sole install path)', () => {
    const shim = readFileSync(join(REQ, '..', 'requirements.txt'), 'utf8');
    expect(shim).toMatch(/^-r requirements\/nvidia-cuda\.txt/m);
  });
  it('NO cpu.txt / amd-rocm.txt in Phase 1', () => {
    expect(() => readFileSync(join(REQ, 'cpu.txt'), 'utf8')).toThrow();
    expect(() => readFileSync(join(REQ, 'amd-rocm.txt'), 'utf8')).toThrow();
  });
});
