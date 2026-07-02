import { configValue } from '../config/resolver.js';
import type { VramState } from './vram-state.js';

/** Evict a resident Ollama analyzer before loading a sidecar TTS/voice-design
    model? CPU: never. GPU with unknown/never-probed total: yes (conservative).
    GPU below `gpu.safeCoexistMb`: yes; at/above: no (12/16 GB coexist).

    `engineOnGpu` (W2.6, default true): the engine about to load. When false
    (its configured device knob is confirmed CPU/mps), it categorically can't
    contend with the analyzer for GPU memory, so eviction is skipped outright
    regardless of the resident card's size. */
export function shouldEvictBeforeSidecarLoad(v: VramState, engineOnGpu: boolean = true): boolean {
  if (!engineOnGpu) return false; // this engine isn't touching the GPU — nothing to evict for.
  if (v.accelerator === 'cpu') return false;
  if (v.totalMb == null) return true;
  return v.totalMb < configValue<number>('gpu.safeCoexistMb');
}
