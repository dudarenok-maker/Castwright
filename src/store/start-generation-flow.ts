/* Start-generation flow (P3 — pre-generation voice-model prompt).
 *
 * The "Approve cast & start generating" / "Resume generation" CTAs route through
 * this thunk instead of dispatching `requestStartGeneration` directly. For a
 * Qwen book it opens the "Choose voice model" prompt so the user picks the tier
 * (0.6B fast / 1.7B quality) at the moment of starting — defaulting to whatever
 * the cast is pinned to. For a non-Qwen book (Kokoro / Coqui / Gemini) the tier
 * choice is meaningless, so it starts immediately (byte-identical to the old
 * direct dispatch). The modal's confirm applies the chosen tier to the cast and
 * then dispatches the real `requestStartGeneration`. */

import { uiActions } from './ui-slice';
import { engineForModelKey } from '../lib/tts-models';
import type { AppDispatch, RootState } from './index';
import type { Character } from '../lib/types';

/** A character renders on Qwen iff its own engine (or the run default when it
    has none) resolves to 'qwen' — mirrors the server's `resolveCharacterEngine`
    (`server/src/tts/per-character-engine.ts`), so the prompt shows exactly when
    at least one line will actually be synthesised by Qwen. */
export function castRendersOnQwen(
  characters: ReadonlyArray<Character>,
  runModelKey: Parameters<typeof engineForModelKey>[0],
): boolean {
  const runEngine = engineForModelKey(runModelKey);
  return characters.some((c) => (c.ttsEngine ?? runEngine) === 'qwen');
}

export function startGenerationFlow() {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const { cast, ui } = getState();
    if (castRendersOnQwen(cast.characters, ui.ttsModelKey)) {
      dispatch(uiActions.openStartGenPrompt());
    } else {
      dispatch(uiActions.requestStartGeneration());
    }
  };
}
