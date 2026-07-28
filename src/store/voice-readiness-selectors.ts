import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { compareCastRows } from '../lib/cast-sort';
import { resolveVoiceStatus } from '../lib/voice-status';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { ALL_TTS_ENGINES, engineForModelKey } from '../lib/tts-models';

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
          /* preferCurrentBook: true — `characters` is state.cast.characters,
             the currently-open book's own roster (see the doc comment
             above), so a same-id `source: 'current'` match is safe here. */
          resolveVoiceStatus(c, findVoiceForCharacter(c, library, true), c.ttsEngine ?? ttsEngine)
            .lifecycle?.label === 'Needs voice',
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

export interface BookFallbackEligibility {
  isEnglish: boolean;
  /** False only when NEITHER Coqui nor Kokoro can read this book's language —
      the gate's hard block. */
  hasFallback: boolean;
  /** The engine the "Proceed anyway" button would actually render with.
      Meaningless when `hasFallback` is false (no proceed button is shown). */
  fallbackEngine: 'Coqui' | 'Kokoro';
}

/** fs-60/#1534 — the ONE derivation of a book's Qwen-fallback situation.
    `selectHasNoFallbackEngine`, `selectFallbackEngineName` and
    `voiceReadinessGateMessage` all read it, so the soft-gate/hard-block
    decision, the button's engine name and the gate copy can never name
    different engines. They used to each re-derive this, and in the
    (today-unreachable) "non-English but Kokoro-eligible, not Coqui-eligible"
    state they disagreed: soft-gate + a button saying "Kokoro" + a message
    saying "Coqui" + a server `applyQwenFallback` that throws. fs-70 (#1303)
    makes that state reachable by widening Kokoro's language support.

    `fallbackEngine` mirrors the server's applyQwenFallback
    (server/src/tts/synthesise-chapter.ts) exactly — Coqui when the book is
    non-English AND Coqui is eligible, Kokoro otherwise — so the UI never
    promises a fallback the server won't use.

    Missing book data (library not yet loaded) defaults to "every engine is
    eligible", i.e. NOT blocked — mirroring the old selectIsBookNonEnglish's
    "defaults to English" posture for the same missing-data case, rather than
    flashing a hard block while the library is still loading. */
export function getBookFallbackEligibility(
  state: RootState,
  bookId: string,
): BookFallbackEligibility {
  const book = state.library?.books?.find((b) => b.bookId === bookId);
  const eligible = book?.eligibleTtsEngines ?? ALL_TTS_ENGINES;
  const isEnglish = (book?.language ?? 'en') === 'en';
  return {
    isEnglish,
    hasFallback: eligible.includes('coqui') || eligible.includes('kokoro'),
    fallbackEngine: !isEnglish && eligible.includes('coqui') ? 'Coqui' : 'Kokoro',
  };
}

/** fs-60 — true only when this book's language has NO fallback engine at
    all (neither Coqui nor Kokoro is in eligibleTtsEngines). A Coqui-eligible
    language (en/ru/es/fr/de/zh/ja) gets the soft-gate below instead of a hard
    block, since an undesigned Qwen character falls back to Coqui rather than
    failing. */
export function selectHasNoFallbackEngine(state: RootState, bookId: string): boolean {
  return !getBookFallbackEligibility(state, bookId).hasFallback;
}

/** fs-60 — the display name of the fallback engine the "Proceed anyway"
    button would actually render with, for this book. */
export function selectFallbackEngineName(state: RootState, bookId: string): 'Coqui' | 'Kokoro' {
  return getBookFallbackEligibility(state, bookId).fallbackEngine;
}

/** fs-46/fs-60 — message-builder pair mirroring `analysisBusyMessage`. Three
    branches: English's existing soft-gate (Kokoro fallback), the non-English
    soft-gate (ru/es/fr/de/zh/ja), and the no-fallback-engine hard block
    (unchanged copy). The engine is NAMED from the shared helper rather than
    re-derived, so it always matches `selectFallbackEngineName` (#1534).
    Returns null when the gate shouldn't fire. */
export function voiceReadinessGateMessage(state: RootState, bookId: string): string | null {
  if (!selectVoiceReadinessGateShouldFire(state, bookId)) return null;
  const { isEnglish, hasFallback, fallbackEngine } = getBookFallbackEligibility(state, bookId);
  if (!hasFallback) {
    return "This book can't fall back to a generic voice — every speaking character needs a designed voice.";
  }
  return isEnglish
    ? `These speaking characters haven't been designed yet. Design them now, or proceed and they'll render with a generic ${fallbackEngine} fallback voice.`
    : `These speaking characters haven't been designed yet. Design them now, or proceed and they'll render with a ${fallbackEngine} fallback voice.`;
}
