/* Resolves whether a TTS engine's CONFIGURED device knob is GPU or CPU-family
   — used by the Wave 2 §W2.6 Node guards, which can only reason about whether
   the engine about to load/run touches the GPU at all (never which card). */

import { configValue } from '../config/resolver.js';

const ENGINE_DEVICE_KEY: Record<string, string> = {
  qwen: 'tts.qwen.device',
  coqui: 'tts.coqui.device',
  kokoro: 'tts.kokoro.device',
};

/** True when `engine`'s configured device knob resolves to a GPU family
    (cuda/cuda:N, or auto — which usually resolves to a GPU, so treated as
    GPU conservatively). False only for an explicit cpu/mps pin. An engine
    with no registered device knob (e.g. 'gemini', a cloud engine) defaults
    to true — the conservative "assume contention is possible" choice, so a
    new engine never silently defeats these guards. */
export function engineDeviceIsGpu(engine: string): boolean {
  const key = ENGINE_DEVICE_KEY[engine];
  if (!key) return true;
  const raw = (configValue<string>(key) ?? 'auto').trim().toLowerCase();
  return raw === 'auto' || raw.startsWith('cuda');
}
