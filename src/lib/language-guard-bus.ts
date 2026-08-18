/* language-guard-bus — the seam between the non-React API layer and the
   React language-guard modal (#2246 Task 9c).

   The four pre-flight 409 sites live in `src/lib/api.ts` (splice, audio
   QA-repair, analysis, qwen voice-design), which is not a React module and
   cannot call a hook. This module is the bridge: `useLanguageGuard` registers
   a handler on mount; the API layer, when it sees a 409 whose body marks an
   unset book language, calls `emitLanguageGuard` instead of surfacing a
   generic error toast. The handler opens the modal in guard mode; on save it
   persists the chosen language and re-runs the original call via `onRetry`.

   The detector lives here too so the API layer and the tests share one
   implementation, and so the two body shapes are both covered. */

import type { LanguageGuardShape } from '../modals/edit-book-meta';

export interface LanguageGuardRequest {
  bookId: string;
  shape: LanguageGuardShape;
  /** The original action that failed because the language was unset. Called
      after the language patch is saved in guard mode. */
  onRetry: () => void;
}

type LanguageGuardHandler = (req: LanguageGuardRequest) => void;

let currentHandler: LanguageGuardHandler | null = null;

/** Register the runtime's single language-guard modal handler. The hook calls
    this on mount and clears it on unmount, so exactly one handler is live at a
    time (the layout hosts one instance). */
export function setLanguageGuardHandler(handler: LanguageGuardHandler | null): void {
  currentHandler = handler;
}

/** Route a language-unset failure to the guard modal. Returns true when a
    handler was live and accepted the request (so the API layer knows it should
    NOT surface its usual generic error), false when no handler is mounted. */
export function emitLanguageGuard(req: LanguageGuardRequest): boolean {
  if (!currentHandler) return false;
  currentHandler(req);
  return true;
}

/** True when an HTTP response body marks an unset book language. The four 409
    sites split the marker across two fields:
      - chapter-splice / chapter-qa-repair / analysis send
        `{ error: 'language_unset' }` (no `code` at all);
      - qwen-voice sends `{ error: <human message>, code: 'language_unset' }`.
    A detector that checks only one of the two fields silently misses a quarter
    of the surface, so both are checked. */
export function isLanguageUnsetBody(status: number, body: string): boolean {
  if (status !== 409) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    return parsed.error === 'language_unset' || parsed.code === 'language_unset';
  } catch {
    return false;
  }
}
