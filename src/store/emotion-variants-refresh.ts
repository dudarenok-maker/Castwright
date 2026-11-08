/* #4040 — after a base redesign lands, the server marks every emotion variant
 * minted from the old base stale (book GET / cast PUT / render drop them) on
 * every row sharing that voice key. The open tab only knows about the row it
 * redesigned, so re-read the book and prune the local variants the server no
 * longer carries (`cast/pruneStaleEmotionVariants` — variants only, so unsaved
 * edits to other cast fields survive). Best-effort: a failed read leaves the
 * tab as it was and the next book open reads the truth.
 *
 * Scope is narrow on purpose (PR #4061 review): the prune is autosaved, and the
 * PUT never refills a cast row's variants, so a wrong prune is permanent.
 *   - the read must be of the book the slices HOLD (the Voices view's
 *     per-series Rebaseline redesigns a book that is not loaded, and series
 *     books share character ids);
 *   - only rows on the redesigned voice key are touched (the server's
 *     `qwenVariantBaseKey`, mirrored in `variantBaseKey`);
 *   - only emotions present in the store at dispatch time, so a variant that
 *     reached the store while the read was in flight survives;
 *   - skipped under VITE_USE_MOCKS: the mock design never records variants, so
 *     its read cannot tell "stale" from "never recorded" (the drawer's instant
 *     clear is the half a mock backend serves). */

import { castActions } from './cast-slice';
import { api } from '../lib/api';
import type { Character } from '../lib/types';
import type { AppDispatch, RootState } from './index';

/* The key the server derives a row's variants from (server/src/workspace/
   variant-base-rev.ts qwenVariantBaseKey): a library slot's `qwen-<uuid>`, else
   the row's storage key. */
export function variantBaseKey(c: Character): string {
  const qwen = c.overrideTtsVoices?.qwen as { libraryUuid?: string } | undefined;
  if (qwen?.libraryUuid) return `qwen-${qwen.libraryUuid}`;
  return c.voiceUuid ? `qwen-${c.voiceUuid}` : `qwen-${c.voiceId ?? c.id}`;
}

export function refreshEmotionVariants(bookId: string, characterId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    if (import.meta.env.VITE_USE_MOCKS === 'true') return;
    try {
      const { cast, manuscript } = getState();
      const redesigned = cast.characters.find((c) => c.id === characterId);
      if (!redesigned) return;
      const key = variantBaseKey(redesigned);
      const loadedId = manuscript.manuscriptId;
      const snapshot = cast.characters
        .filter((c) => variantBaseKey(c) === key)
        .map((c) => ({ id: c.id, emotions: Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}) }))
        .filter((r) => r.emotions.length > 0);
      if (snapshot.length === 0) return;
      const res = await api.getBookState(bookId);
      const characters = res?.cast?.characters;
      if (!characters || !loadedId) return;
      /* The read must be of the book the slices still hold, not merely a book
         that did not change while we waited. */
      if (res.state?.manuscriptId !== loadedId || getState().manuscript.manuscriptId !== loadedId) return;
      const fresh = new Map(characters.map((c) => [c.id, c.overrideTtsVoices?.qwen?.variants]));
      dispatch(
        castActions.pruneStaleEmotionVariants(
          snapshot
            .filter((r) => fresh.has(r.id))
            .map((r) => ({ id: r.id, emotions: r.emotions, variants: fresh.get(r.id) })),
        ),
      );
    } catch {
      /* non-fatal — see the header */
    }
  };
}
