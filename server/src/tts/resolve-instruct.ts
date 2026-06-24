/* fs-57 §P-Mo1 — pure instruct resolver for the 1.7B liveInstruct synth path.
   Decides whether to attach a delivery direction to a sentence group's sidecar
   call. Gate: BOTH is17b (caller-derived) AND liveInstruct (per-book flag)
   must be true; any other combination returns {} (no instruct). When the gate
   is open, an explicit group.instruct wins; otherwise falls back to the emotion
   phrase from emotionToInstruct. neutral/absent emotion ⇒ no instruct. */

import { emotionToInstruct } from './emotion-instruct.js';

interface InstructGroup {
  instruct?: string;
  emotion?: string;
}

/** Resolve the sidecar instruct string for one sentence group.
 *
 * @param group     The sentence group (carries optional instruct + emotion).
 * @param is17b     True when the resolved model key is `qwen3-tts-1.7b`. The
 *                  caller derives this via
 *                  `canonicalModelKeyForEngine('qwen', modelKey) === 'qwen3-tts-1.7b'`.
 *                  Do NOT invent a tier enum — the boolean is the contract.
 * @param liveInstruct  The per-book flag (from state.json). Must be `?? false`
 *                      at the call site so `undefined` (legacy books) is never
 *                      truthy.
 * @returns `{ instruct: string }` when the gate is open and a phrase is
 *          available, or `{}` otherwise (no instruct key present).
 */
export function resolveInstructForGroup(
  group: InstructGroup,
  { is17b, liveInstruct }: { is17b: boolean; liveInstruct: boolean },
): { instruct?: string } {
  if (!is17b || !liveInstruct) return {};
  const phrase = group.instruct ?? emotionToInstruct(group.emotion as Parameters<typeof emotionToInstruct>[0]);
  if (!phrase) return {};
  return { instruct: phrase };
}
