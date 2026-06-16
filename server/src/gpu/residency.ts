import { configValue } from '../config/resolver.js';
import type { VramState } from './vram-state.js';

/** Evict a resident Ollama analyzer before loading a sidecar TTS/voice-design
    model? CPU: never. GPU with unknown/never-probed total: yes (conservative).
    GPU below `gpu.safeCoexistMb`: yes; at/above: no (12/16 GB coexist). */
export function shouldEvictBeforeSidecarLoad(v: VramState): boolean {
  if (v.accelerator === 'cpu') return false;
  if (v.totalMb == null) return true;
  return v.totalMb < configValue<number>('gpu.safeCoexistMb');
}
