import type { TtsEngine } from '../tts/model-keys.js';

export type VoiceKind = 'designed' | 'cloned' | 'preset';

/** Designed (Qwen, bespoke per character) and cloned (Coqui/XTTS from a
    reference sample) are "bespoke" — the moat. Catalogue presets (Kokoro,
    Gemini) are not. Coqui defaults to preset unless the caller knows the
    voice came from a clone (a reference sample), signalled via opts.cloned. */
export function voiceKindFor(
  engine: TtsEngine | null | undefined,
  opts: { cloned?: boolean } = {},
): VoiceKind {
  if (engine === 'qwen') return 'designed';
  if (engine === 'coqui') return opts.cloned ? 'cloned' : 'preset';
  return 'preset';
}
