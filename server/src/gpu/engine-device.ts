/* Resolves whether a TTS engine's ACTUAL runtime device is GPU or CPU-family.
   Ground truth (getLastKnownEngineDevice, fed from the sidecar's side-14
   per-engine devices map) wins whenever it's known; the CONFIGURED device
   knob is only a fallback for when that engine has never been probed (e.g.
   before the sidecar's first health poll). Used by the Wave 2 §W2.6 Node
   guards, which reason about whether the engine about to load/run touches
   the GPU at all (never which card) — and, since this design, also gates
   whether a synth/design call enters the GPU semaphore at all. */

import { configValue } from '../config/resolver.js';
import { getLastKnownEngineDevice } from './engine-device-state.js';

const ENGINE_DEVICE_KEY: Record<string, string> = {
  qwen: 'tts.qwen.device',
  coqui: 'tts.coqui.device',
  kokoro: 'tts.kokoro.device',
};

const GPU_FAMILIES = new Set(['cuda', 'rocm', 'directml']);

/** True when `engine` actually touches the GPU. Ground truth first: if the
    engine's last-known runtime device is known (cuda/rocm/directml/mps/cpu),
    that answer is authoritative. Only when it's 'unknown' (never probed, or
    an old sidecar) does this fall back to the CONFIGURED device knob —
    cuda/cuda:N, or auto (usually resolves to a GPU, so treated as GPU
    conservatively). False only for an explicit cpu/mps pin. An engine with
    no registered device knob (e.g. 'gemini', a cloud engine) defaults to
    true — the conservative "assume contention is possible" choice, so a new
    engine never silently defeats these guards. */
export function engineDeviceIsGpu(engine: string): boolean {
  const known = getLastKnownEngineDevice(engine);
  if (known !== 'unknown') return GPU_FAMILIES.has(known);
  const key = ENGINE_DEVICE_KEY[engine];
  if (!key) return true;
  const raw = (configValue<string>(key) ?? 'auto').trim().toLowerCase();
  return raw === 'auto' || raw.startsWith('cuda');
}
