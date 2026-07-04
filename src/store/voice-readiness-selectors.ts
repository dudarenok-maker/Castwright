import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { compareCastRows } from '../lib/cast-sort';
import { resolveVoiceStatus } from '../lib/voice-status';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { engineForModelKey } from '../lib/tts-models';

export interface UndesignedCharacterRow {
  id: string;
  name: string;
  lines: number;
}

/** fe-46 — every character whose lifecycle is "Needs voice" (a Qwen-effective
    character with no designed voice), most-spoken first. Mirrors the cast
    view's `needsVoiceIds` EXACTLY (same filter, same sort, no lines filter)
    so the gate's "Design full cast" and the cast view's button always design
    the same roster and counts agree — never fork this definition (plan 240
    invariant 2). `bookId` is kept for API symmetry with
    `selectAnalysisBusyForBook` even though `state.cast` is single-book-scoped
    today — don't "clean up" the unused param later.

    Memoised via createSelector (#1285): the unmemoized version allocated a
    fresh array on every call — react-redux's dev-mode stability check flags
    that as "returned a different result", and `VoiceReadinessGateModal`
    (a global, always-mounted overlay) called this on every render, forcing
    a re-render on every store dispatch. */
export const selectUndesignedQwenCharacters = createSelector(
  [
    (state: RootState) => state.ui.ttsModelKey,
    (state: RootState) => state.cast.characters,
    (state: RootState) => state.voices.voices,
    (_state: RootState, bookId: string) => bookId,
  ],
  (ttsModelKey, characters, library): UndesignedCharacterRow[] => {
    const ttsEngine = engineForModelKey(ttsModelKey);
    return characters
      .filter(
        (c) =>
          resolveVoiceStatus(c, findVoiceForCharacter(c, library), c.ttsEngine ?? ttsEngine).lifecycle
            ?.label === 'Needs voice',
      )
      .slice()
      .sort(compareCastRows)
      .map((c) => ({ id: c.id, name: c.name, lines: c.lines ?? 0 }));
  },
);

/** fe-46 — the gate FIRES only when at least one undesigned character actually
    speaks (`lines > 0`); a 0-line undesigned character can never trigger the
    server's Qwen→Kokoro fallback, so it must not block generation (it still
    appears in the list above / gets designed by the "Design full cast" CTA).
    Plan 240 invariant 3: list ⊇ firing set, by design. */
export function selectVoiceReadinessGateShouldFire(state: RootState, bookId: string): boolean {
  return selectUndesignedQwenCharacters(state, bookId).some((c) => c.lines > 0);
}

/** fe-46 — mirrors the existing non-English check in `cast.tsx`
    (`bookLanguage !== 'en'`); no BCP-47 subtag parsing client-side. */
export function selectIsBookNonEnglish(state: RootState, bookId: string): boolean {
  const language = state.library?.books?.find((b) => b.bookId === bookId)?.language ?? 'en';
  return language !== 'en';
}

/** fe-46 — message-builder pair mirroring `analysisBusyMessage`
    (`analysis-substage-selectors.ts`): distinct copy for the English
    soft-gate vs. the non-English hard block, rendered verbatim by
    `VoiceReadinessGateModal` — the single source of truth for this copy, so
    the modal body text can never drift from what this selector promises.
    Returns null when the gate shouldn't fire at all. */
export function voiceReadinessGateMessage(state: RootState, bookId: string): string | null {
  if (!selectVoiceReadinessGateShouldFire(state, bookId)) return null;
  return selectIsBookNonEnglish(state, bookId)
    ? "This book can't fall back to a generic voice — every speaking character needs a designed voice."
    : "These speaking characters haven't been designed yet. Design them now, or proceed and they'll render with a generic Kokoro fallback voice.";
}
