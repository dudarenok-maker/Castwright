/* Start-generation flow (P3 — pre-generation voice-model prompt; plan 276 —
 * cast-time clone-readiness gate).
 *
 * The "Approve cast & start generating" / "Resume generation" CTAs route through
 * this thunk instead of dispatching `requestStartGeneration` directly. For a
 * Qwen book it opens the "Choose voice model" prompt so the user picks the tier
 * (0.6B fast / 1.7B quality) at the moment of starting — defaulting to whatever
 * the cast is pinned to. For a non-Qwen book (Kokoro / Coqui / Gemini) the tier
 * choice is meaningless, so it starts immediately (byte-identical to the old
 * direct dispatch). The modal's confirm applies the chosen tier to the cast and
 * then dispatches the real `requestStartGeneration`.
 *
 * Plan 276 — a cloned voice that would not resolve on its routed engine gets
 * its own gate, checked independently of the Qwen-only branch above (Decision
 * 5: "the clone check gets its own entry condition and early return... a
 * Coqui-only cloned cast must reach the clone gate and must NOT see a tier
 * chooser"). Both dispatch sites (`src/routes/index.tsx`,
 * `src/views/generation.tsx`) are fire-and-forget `onClick`s, so this being
 * async and returning an ignored Promise is safe. */

import { uiActions } from './ui-slice';
import { engineForModelKey } from '../lib/tts-models';
import { selectVoiceReadinessGateShouldFire } from './voice-readiness-selectors';
import { fetchVoiceLibrary } from './voice-library-slice';
import { castNeedsCloneCheck, selectCloneReadinessGateShouldFire } from './clone-readiness-selectors';
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
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    dispatch(uiActions.setStartGenerationPending(true));
    try {
      const state = getState();
      const { cast, ui } = state;
      const bookId = ui.stage.kind === 'ready' ? ui.stage.bookId : null;
      const rendersOnQwen = castRendersOnQwen(cast.characters, ui.ttsModelKey);

      /* fe-46 — pre-flight voice-readiness gate takes precedence over both
         the tier prompt AND the clone gate below: a speaking Qwen character
         with no designed voice needs an explicit, informed choice (design
         now / proceed anyway) before either is even relevant. Partially-
         designed casts still need the tier prompt for their designed
         characters — deliberately NOT merged. */
      if (rendersOnQwen && bookId && selectVoiceReadinessGateShouldFire(state, bookId)) {
        dispatch(uiActions.openVoiceReadinessGate({ bookId }));
        return;
      }

      /* Plan 276 Decision 5 — its OWN entry condition and early return,
         independent of `rendersOnQwen`: a Coqui-only cloned cast must reach
         this gate. `fetchVoiceLibrary` (Decision 2) ensures the library
         entries are actually loaded — the cast view never fetches it itself
         (only `my-voices-section.tsx` does) — so the slice can be empty here
         even though a cloned voice IS assigned. Skipped when no character
         could possibly trip the check at all, to avoid a needless fetch on
         every plain (non-cloned) book's start-generation click. */
      /* Plan 276 Decision 5 — its OWN entry condition and early return,
         independent of `rendersOnQwen`: a Coqui-only cloned cast must reach
         this gate. `fetchVoiceLibrary` (Decision 2) ensures the library
         entries are actually loaded — the cast view never fetches it itself
         (only `my-voices-section.tsx` does) — so the slice can be empty here
         even though a cloned voice IS assigned. Skipped when no character
         could possibly trip the check at all, to avoid a needless fetch on
         every plain (non-cloned) book's start-generation click. */
      if (bookId && castNeedsCloneCheck(cast.characters)) {
        try {
          await dispatch(fetchVoiceLibrary());
        } catch {
          /* Decision 5 — fails open: an advisory this thunk couldn't
             compute must never block the user from generating. */
          dispatch(uiActions.requestStartGeneration());
          return;
        }
        if (selectCloneReadinessGateShouldFire(getState(), bookId)) {
          dispatch(uiActions.openCloneReadinessGate({ bookId }));
          return;
        }
      }

      if (!rendersOnQwen) {
        dispatch(uiActions.requestStartGeneration());
        return;
      }
      dispatch(uiActions.openStartGenPrompt());
    } finally {
      dispatch(uiActions.setStartGenerationPending(false));
    }
  };
}
