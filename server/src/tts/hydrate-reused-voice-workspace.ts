/* Workspace-backed wiring for hydrate-reused-voice. Keeps the pure resolver
   (hydrate-reused-voice.ts) free of filesystem/workspace imports so it stays
   unit-testable, while giving generation + the voices API a one-call helper
   that reads sibling books' cast.json on demand.

   The per-request loader memoises each source book's cast so hydrating a whole
   cast (many reused characters often share one source book) reads each
   cast.json at most once. */

import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import {
  hydrateCharacterVoice,
  type CastLoader,
  type ReuseHydratable,
} from './hydrate-reused-voice.js';

/** A memoised CastLoader over the workspace: bookId → that book's characters. */
export function createWorkspaceCastLoader(): CastLoader {
  const cache = new Map<string, ReuseHydratable[] | null>();
  return async (bookId: string) => {
    if (cache.has(bookId)) return cache.get(bookId) ?? null;
    let chars: ReuseHydratable[] | null = null;
    try {
      const located = await findBookByBookId(bookId);
      if (located) {
        const cast = await readJson<{ characters?: ReuseHydratable[] }>(
          castJsonPath(located.bookDir),
        );
        chars = cast?.characters ?? null;
      }
    } catch {
      chars = null;
    }
    cache.set(bookId, chars);
    return chars;
  };
}

/** Hydrate every reused character in a cast against the workspace, sharing one
    memoised loader across the batch. Characters that already own a bespoke
    voice (or aren't reuses) pass through untouched. */
export async function hydrateCastReusedVoices<T extends ReuseHydratable>(
  characters: T[],
  load: CastLoader = createWorkspaceCastLoader(),
): Promise<T[]> {
  return Promise.all(characters.map((c) => hydrateCharacterVoice(c, load)));
}
